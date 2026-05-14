import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as fs from "fs";
import * as path from "path";

const cfg = new pulumi.Config();
const isMinikube = cfg.getBoolean("isMinikube") ?? false;

const appNs = new k8s.core.v1.Namespace("guestbook-ns", { metadata: { name: "guestbook" } });
const monNs = new k8s.core.v1.Namespace("monitoring-ns", { metadata: { name: "monitoring" } });

const grafanaPassword = cfg.getSecret("grafanaAdminPassword") ??
    new random.RandomPassword("grafana-pw", { length: 20, special: false }).result;

// redis_exporter sidecar so Prometheus can scrape Redis on :9121
const redisExporter: k8s.types.input.core.v1.Container = {
    name: "redis-exporter",
    image: "oliver006/redis_exporter:v1.62.0-alpine",
    args: ["--redis.addr=redis://localhost:6379"],
    ports: [{ name: "metrics", containerPort: 9121 }],
};

// redis-leader
const leaderLabels = { app: "redis", role: "leader", tier: "backend" };
const leaderDep = new k8s.apps.v1.Deployment("redis-leader", {
    metadata: { namespace: appNs.metadata.name, name: "redis-leader" },
    spec: {
        replicas: 1,
        selector: { matchLabels: leaderLabels },
        template: {
            metadata: { labels: leaderLabels },
            spec: {
                containers: [
                    { name: "leader", image: "redis:7.2-alpine", ports: [{ name: "redis", containerPort: 6379 }] },
                    redisExporter,
                ],
            },
        },
    },
});
new k8s.core.v1.Service("redis-leader", {
    metadata: {
        namespace: appNs.metadata.name, name: "redis-leader",
        labels: { ...leaderLabels, "app.kubernetes.io/component": "redis-leader" },
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: "redis" },
            { name: "metrics", port: 9121, targetPort: "metrics" },
        ],
        selector: leaderLabels,
    },
}, { dependsOn: leaderDep });

// redis-replica
const replicaLabels = { app: "redis", role: "replica", tier: "backend" };
const replicaDep = new k8s.apps.v1.Deployment("redis-replica", {
    metadata: { namespace: appNs.metadata.name, name: "redis-replica" },
    spec: {
        replicas: 2,
        selector: { matchLabels: replicaLabels },
        template: {
            metadata: { labels: replicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "gcr.io/google_samples/gb-redisslave:v3",
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ name: "redis", containerPort: 6379 }],
                    },
                    redisExporter,
                ],
            },
        },
    },
});
new k8s.core.v1.Service("redis-replica", {
    metadata: {
        namespace: appNs.metadata.name, name: "redis-replica",
        labels: { ...replicaLabels, "app.kubernetes.io/component": "redis-replica" },
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: "redis" },
            { name: "metrics", port: 9121, targetPort: "metrics" },
        ],
        selector: replicaLabels,
    },
}, { dependsOn: replicaDep });

// frontend
const feLabels = { app: "guestbook", tier: "frontend" };
const feDep = new k8s.apps.v1.Deployment("frontend", {
    metadata: { namespace: appNs.metadata.name, name: "frontend" },
    spec: {
        replicas: 3,
        selector: { matchLabels: feLabels },
        template: {
            metadata: { labels: feLabels },
            spec: {
                containers: [{
                    name: "php-redis",
                    image: "us-docker.pkg.dev/google-samples/containers/gke/gb-frontend:v5",
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{ name: "http", containerPort: 80 }],
                }],
            },
        },
    },
});
const feSvc = new k8s.core.v1.Service("frontend", {
    metadata: {
        namespace: appNs.metadata.name, name: "frontend",
        labels: { ...feLabels, "app.kubernetes.io/component": "frontend" },
    },
    spec: {
        type: "ClusterIP",
        ports: [{ name: "http", port: 80, targetPort: "http" }],
        selector: feLabels,
    },
}, { dependsOn: feDep });

// kube-prometheus-stack
const kps = new k8s.helm.v3.Release("kube-prometheus-stack", {
    chart: "kube-prometheus-stack",
    version: "65.5.1",
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    namespace: monNs.metadata.name,
    values: {
        prometheus: {
            prometheusSpec: {
                serviceMonitorSelectorNilUsesHelmValues: false,
                podMonitorSelectorNilUsesHelmValues: false,
                ruleSelectorNilUsesHelmValues: false,
                retention: "6h",
            },
        },
        grafana: {
            adminPassword: grafanaPassword,
            service: { type: isMinikube ? "NodePort" : "LoadBalancer", port: 80 },
            sidecar: {
                dashboards: { enabled: true, label: "grafana_dashboard", labelValue: "1", searchNamespace: "ALL" },
            },
        },
        alertmanager: { enabled: false },
    },
});

const grafanaSvc = pulumi.all([kps.status, monNs.metadata.name]).apply(([s, ns]) =>
    k8s.core.v1.Service.get("grafana-svc", pulumi.interpolate`${ns}/${s.name}-grafana`, { dependsOn: kps }),
);

// ServiceMonitors
function serviceMonitor(name: string, component: string, port: string, interval = "15s") {
    return new k8s.apiextensions.CustomResource(name, {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: { name, namespace: monNs.metadata.name },
        spec: {
            namespaceSelector: { matchNames: [appNs.metadata.name] },
            selector: { matchLabels: { "app.kubernetes.io/component": component } },
            endpoints: [{ port, path: "/metrics", interval }],
        },
    }, { dependsOn: kps });
}
serviceMonitor("redis-leader-monitor", "redis-leader", "metrics");
serviceMonitor("redis-replica-monitor", "redis-replica", "metrics");
serviceMonitor("frontend-monitor", "frontend", "http", "30s");

// Dashboard ConfigMap (Grafana sidecar auto-imports anything labeled grafana_dashboard=1)
new k8s.core.v1.ConfigMap("guestbook-dashboard", {
    metadata: {
        name: "guestbook-dashboard",
        namespace: monNs.metadata.name,
        labels: { grafana_dashboard: "1" },
    },
    data: {
        "guestbook-dashboard.json": fs.readFileSync(
            path.join(__dirname, "dashboards", "guestbook-dashboard.json"), "utf8",
        ),
    },
}, { dependsOn: kps });

// Outputs
function endpoint(svc: pulumi.Output<k8s.core.v1.Service>, port: number) {
    return svc.apply(s => pulumi.all([s.status, s.spec]).apply(([st, sp]) => {
        if (sp.type === "LoadBalancer") {
            const host = st.loadBalancer?.ingress?.[0]?.hostname ?? st.loadBalancer?.ingress?.[0]?.ip;
            return host ? `http://${host}${port === 80 ? "" : `:${port}`}` : "pending";
        }
        if (sp.type === "NodePort") {
            const np = sp.ports?.find(p => p.port === port)?.nodePort;
            return np ? `NodePort ${np} (use minikube service or node IP)` : "pending";
        }
        return `ClusterIP (use kubectl port-forward)`;
    }));
}

export const guestbookUrl = endpoint(pulumi.output(feSvc), 80);
export const grafanaUrl = endpoint(grafanaSvc, 80);
export const grafanaUser = "admin";
export const grafanaPasswordOut = pulumi.secret(grafanaPassword);

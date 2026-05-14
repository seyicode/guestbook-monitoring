# Guestbook with Prometheus and Grafana

Pulumi project that deploys the Kubernetes Guestbook (redis leader, redis replicas, php frontend) and adds Prometheus + Grafana on top via the `kube-prometheus-stack` Helm chart.

## What you get

- Guestbook app in the `guestbook` namespace
- redis_exporter sidecar on both redis deployments so Redis metrics get scraped
- kube-prometheus-stack (Prometheus, Grafana, kube-state-metrics, node-exporter) in `monitoring`
- ServiceMonitors for frontend, redis-leader, redis-replica
- A Grafana dashboard auto-loaded via the sidecar pattern

## Prereqs

- Pulumi CLI
- Node 18+
- kubectl pointed at a cluster

## Deploy

```bash
npm install
pulumi stack init dev
pulumi up
```

On minikube/kind, run this first so the frontend stays ClusterIP and Grafana goes NodePort:

```bash
pulumi config set isMinikube true
```

To pin the Grafana password instead of letting it generate one:

```bash
pulumi config set --secret grafanaAdminPassword 'your-password-here'
```

## Get access info

```bash
pulumi stack output
pulumi stack output grafanaPasswordOut --show-secrets
```

Grafana login is `admin` + that password. If `grafanaUrl` says `pending`, the LB is still being allocated, give it a minute.

On minikube:
```bash
minikube service -n monitoring $(kubectl -n monitoring get svc -l app.kubernetes.io/name=grafana -o jsonpath='{.items[0].metadata.name}') --url
```

## Verify Prometheus is scraping

Port forward Prometheus:

```bash
PROM=$(kubectl -n monitoring get svc -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')
kubectl -n monitoring port-forward svc/$PROM 9090:9090
```

Open `http://localhost:9090/targets` and look for `redis-leader`, `redis-replica`, `frontend`.

Try some queries:

```
redis_up{namespace="guestbook"}
rate(redis_commands_processed_total{namespace="guestbook"}[1m])
kube_deployment_status_replicas_available{namespace="guestbook"}
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook"}[2m]))
```

Hit the frontend in a loop to make the dashboards move:

```bash
URL=$(pulumi stack output guestbookUrl)
while true; do curl -s -o /dev/null $URL; sleep 0.2; done
```

In Grafana, look for the "Guestbook Application" dashboard.

## Frontend metrics caveat

The stock `gb-frontend:v4` image doesn't expose `/metrics`, so the frontend ServiceMonitor target will show DOWN in Prometheus. Pod CPU, memory, and network are still scraped automatically by cAdvisor and kube-state-metrics, which is what the frontend panels in the dashboard use. If you want real app metrics, swap the image for one that exposes Prometheus metrics, or add an apache_exporter sidecar.

## Cleanup

```bash
pulumi destroy
pulumi stack rm dev
```

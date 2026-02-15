type CounterName = "link_preview_success" | "link_preview_fail";
type GaugeName = "sockets_connected" | "queue_link_preview_depth";

const counters: Record<CounterName, number> = {
  link_preview_success: 0,
  link_preview_fail: 0,
};

const gauges: Record<GaugeName, number> = {
  sockets_connected: 0,
  queue_link_preview_depth: 0,
};

export function incCounter(name: CounterName, by: number = 1) {
  counters[name] = (counters[name] ?? 0) + by;
}

export function setGauge(name: GaugeName, value: number) {
  gauges[name] = value;
}

export function incGauge(name: GaugeName, by: number = 1) {
  gauges[name] = (gauges[name] ?? 0) + by;
}

export function decGauge(name: GaugeName, by: number = 1) {
  gauges[name] = (gauges[name] ?? 0) - by;
}

export function getMetricsSnapshot() {
  return {
    counters: { ...counters },
    gauges: { ...gauges },
    ts: Date.now(),
  };
}


#!/bin/sh
set -eu

template_path="${LIVEKIT_CONFIG_TEMPLATE:-/etc/livekit.yaml.template}"
output_path="${LIVEKIT_CONFIG_OUTPUT:-/tmp/livekit.yaml}"
turn_block_file="/tmp/livekit-turn-servers.yaml"

cp "$template_path" "$output_path"
sed -i "s|REPLACE_SECRET|${LIVEKIT_API_SECRET}|g" "$output_path"

: > "$turn_block_file"

turn_host=$(printf '%s' "${LIVEKIT_TURN_HOST:-}" | tr -d '[:space:]')
turn_secret=$(printf '%s' "${LIVEKIT_TURN_SECRET:-}" | tr -d '[:space:]')
turn_ttl=$(printf '%s' "${LIVEKIT_TURN_TTL:-14400}" | tr -d '[:space:]')
node_ip=$(printf '%s' "${LIVEKIT_NODE_IP:-}" | tr -d '[:space:]')
turn_header_written=0

if [ -n "$node_ip" ]; then
  NODE_IP="$node_ip" awk '
    $0 == "  use_external_ip: true" {
      print "  use_external_ip: false"
      print "  node_ip: " ENVIRON["NODE_IP"]
      next
    }
    { print }
  ' "$output_path" > "${output_path}.node_ip"
  mv "${output_path}.node_ip" "$output_path"
fi

append_turn_server() {
  protocol="$1"
  port="$2"
  if [ -z "$port" ]; then
    return
  fi
  if [ "$turn_header_written" -eq 0 ]; then
    printf '%s\n' '  turn_servers:' >> "$turn_block_file"
    turn_header_written=1
  fi
  {
    printf '%s\n' "    - host: ${turn_host}"
    printf '%s\n' "      port: ${port}"
    printf '%s\n' "      protocol: ${protocol}"
    printf '%s\n' "      secret: \"${turn_secret}\""
    printf '%s\n' "      ttl: ${turn_ttl}"
  } >> "$turn_block_file"
}

if [ -n "$turn_host" ] && [ -n "$turn_secret" ]; then
  udp_port=$(printf '%s' "${LIVEKIT_TURN_UDP_PORT:-3478}" | tr -d '[:space:]')
  tcp_port=$(printf '%s' "${LIVEKIT_TURN_TCP_PORT:-3478}" | tr -d '[:space:]')
  tls_port=$(printf '%s' "${LIVEKIT_TURN_TLS_PORT:-}" | tr -d '[:space:]')

  append_turn_server udp "$udp_port"
  append_turn_server tcp "$tcp_port"
  append_turn_server tls "$tls_port"
fi

TURN_BLOCK_FILE="$turn_block_file" awk '
  BEGIN {
    while ((getline line < ENVIRON["TURN_BLOCK_FILE"]) > 0) {
      block = block line ORS
    }
  }
  $0 == "  __LIVEKIT_RTC_TURN_SERVERS__: null" {
    if (length(block) > 0) {
      printf "%s", block
    }
    next
  }
  { print }
' "$output_path" > "${output_path}.rendered"

mv "${output_path}.rendered" "$output_path"

exec /livekit-server --config "$output_path"

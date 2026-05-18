#!/usr/bin/env bash
# Romania home server: sing-box + frpc tunnel to SPB
# Run as root on Ubuntu linux-amd64

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${SCRIPT_DIR}/.install-tmp"
mkdir -p "${WORK_DIR}"
trap "rm -rf '${WORK_DIR}'" EXIT

# --- sing-box ---
echo "=== Installing sing-box ==="
SING_BOX_VERSION=$(curl -s https://api.github.com/repos/SagerNet/sing-box/releases/latest | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
echo "Downloading sing-box ${SING_BOX_VERSION}..."
curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-amd64.tar.gz" -o "${WORK_DIR}/sing-box.tar.gz"
tar -xzf "${WORK_DIR}/sing-box.tar.gz" -C "${WORK_DIR}"
install -m 755 "${WORK_DIR}/sing-box-${SING_BOX_VERSION}-linux-amd64/sing-box" /usr/local/bin/sing-box

install -d -m 755 /etc/sing-box /var/lib/sing-box
if [ -f "${SCRIPT_DIR}/config.json" ]; then
  install -m 644 "${SCRIPT_DIR}/config.json" /etc/sing-box/config.json
fi
install -m 644 "${SCRIPT_DIR}/sing-box.service" /etc/systemd/system/sing-box.service

# --- frpc ---
echo "=== Installing frpc ==="
FRP_VERSION=$(curl -s https://api.github.com/repos/fatedier/frp/releases/latest | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
echo "Downloading frp ${FRP_VERSION}..."
curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" -o "${WORK_DIR}/frp.tar.gz"
tar -xzf "${WORK_DIR}/frp.tar.gz" -C "${WORK_DIR}"
install -m 755 "${WORK_DIR}/frp_${FRP_VERSION}_linux_amd64/frpc" /usr/local/bin/frpc

install -d -m 755 /etc/frp
if [ -f "${SCRIPT_DIR}/frpc.toml" ]; then
  install -m 644 "${SCRIPT_DIR}/frpc.toml" /etc/frp/frpc.toml
  echo "Edit /etc/frp/frpc.toml: serverAddr, auth.token, secretKey"
fi
install -m 644 "${SCRIPT_DIR}/frpc.service" /etc/systemd/system/frpc.service

# --- enable both ---
systemctl daemon-reload
systemctl enable sing-box frpc

echo ""
echo "Installation complete."
echo "1. Edit /etc/frp/frpc.toml: serverAddr, auth.token, secretKey"
echo "2. Start: systemctl start sing-box frpc"
echo "3. Logs:  journalctl -u sing-box -f   journalctl -u frpc -f"

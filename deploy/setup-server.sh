#!/usr/bin/env bash
# One-time setup of a fresh Akamai (Linode) Ubuntu 24.04 server for Momentum. Run as root:
#   bash setup-server.sh "ssh-ed25519 AAAA... github-deploy"
# The argument is the PUBLIC half of the deploy key that GitHub Actions will use.
set -euo pipefail

DEPLOY_KEY="${1:?Pass the deploy public key as the first argument}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get -y install docker.io docker-compose-v2 ufw unattended-upgrades fail2ban
systemctl enable --now docker
dpkg-reconfigure -f noninteractive unattended-upgrades

# A non-root user that GitHub Actions signs in as to deploy.
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
grep -qxF "$DEPLOY_KEY" /home/deploy/.ssh/authorized_keys 2>/dev/null || echo "$DEPLOY_KEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# App folder; the real settings file is created by hand afterwards (GO-LIVE.md).
install -d -m 750 -o deploy -g deploy /opt/momentum

# Only SSH and the website are reachable.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Key-only SSH, no root sign-in. Make sure your own key works for "deploy" or another sudo user BEFORE closing this session.
cat >/etc/ssh/sshd_config.d/10-momentum.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh

echo "Server ready. Next: create /opt/momentum/.env (see deploy/server.env.example), then run the GitHub deploy workflow."
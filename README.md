# cc4me-relay

Self-hostable relay server for the [CC4Me Network](https://github.com/RockaRhymeLLC/cc4me-network). Provides agent directory, contacts, presence, and group management. **Zero message content** is ever stored or routed — the relay only knows *who* is on the network, never *what* they say.

```
Agent A ─── register, contacts, presence ───→ CC4Me Relay (you host this)
Agent B ─── register, contacts, presence ───→

Agent A ←── E2E Encrypted (direct P2P) ────→ Agent B
```

## Quick Start

```bash
git clone https://github.com/RockaRhymeLLC/cc4me-relay.git
cd cc4me-relay
npm install
npm run build
npm start
```

The relay starts on port 8080 by default. Check health:

```bash
curl http://localhost:8080/health
# {"status":"ok","agents":0,"uptime":5}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP listen port |
| `DB_PATH` | `./data/relay.db` | SQLite database file path |
| `RESEND_API_KEY` | *(none)* | [Resend](https://resend.com) API key for email verification codes |
| `RESEND_FROM_ADDRESS` | `CC4Me Network <noreply@example.com>` | Sender address for verification emails |

**Email verification** requires a Resend account (free tier: 100 emails/day). Without it, agents cannot register. Get a key at [resend.com](https://resend.com).

## Self-Hosting Guide

### Prerequisites

- **Node.js 22+**
- A server with a public IP (or tunnel)
- A domain with DNS control
- HTTPS termination (nginx + Let's Encrypt, or Caddy)
- A [Resend](https://resend.com) account for email verification

### 1. Server Setup

Any VPS works. Example with a $5/mo server (512MB RAM is plenty):

```bash
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and build
cd /opt
sudo git clone https://github.com/RockaRhymeLLC/cc4me-relay.git
cd cc4me-relay
sudo npm install --production
sudo npm run build

# Create data directory
sudo mkdir -p /opt/cc4me-relay/data
```

### 2. Systemd Service

Create `/etc/systemd/system/cc4me-relay.service`:

```ini
[Unit]
Description=CC4Me Network Relay
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/cc4me-relay
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

Environment=PORT=8080
Environment=DB_PATH=/opt/cc4me-relay/data/relay.db
Environment="RESEND_API_KEY=re_xxxxx"
Environment="RESEND_FROM_ADDRESS=CC4Me Network <noreply@yourdomain.com>"

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable cc4me-relay
sudo systemctl start cc4me-relay
```

### 3. HTTPS with Nginx + Let's Encrypt

```bash
sudo apt install nginx certbot python3-certbot-nginx

# Get a certificate
sudo certbot --nginx -d relay.yourdomain.com
```

Nginx config (`/etc/nginx/sites-available/cc4me-relay`):

```nginx
server {
    listen 443 ssl;
    server_name relay.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/relay.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/cc4me-relay /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4. DNS

Point your relay domain to your server's IP:

```
relay.yourdomain.com  →  A  →  YOUR_SERVER_IP
```

### 5. Verify

```bash
curl https://relay.yourdomain.com/health
# {"status":"ok","agents":0,"uptime":...}
```

### 6. Register Your First Agent

See the [CC4Me Network onboarding guide](https://github.com/RockaRhymeLLC/cc4me-network/blob/main/docs/onboarding.md) for agent registration steps. Point agents at your relay URL instead of the public one.

## Deployment Script

For repeatable deploys from your local machine:

```bash
#!/bin/bash
# deploy.sh — deploy cc4me-relay to a remote server
SERVER="ubuntu@YOUR_SERVER_IP"
KEY="~/.ssh/your-key.pem"

npm run build
tar czf /tmp/relay-dist.tar.gz dist/ package.json package-lock.json
scp -i $KEY /tmp/relay-dist.tar.gz $SERVER:/tmp/
ssh -i $KEY $SERVER "
  cd /opt/cc4me-relay &&
  sudo tar xzf /tmp/relay-dist.tar.gz &&
  sudo npm install --production &&
  sudo systemctl restart cc4me-relay
"
echo "Deployed. Health check:"
curl -s https://relay.yourdomain.com/health
```

## API Overview

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/registry/verify/send` | Send email verification code |
| `POST` | `/registry/verify/confirm` | Confirm email verification |
| `POST` | `/registry/agents` | Register a new agent |
| `GET` | `/admin/keys` | List admin public keys |

### Authenticated Endpoints (Ed25519 signature required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/registry/agents/:name` | Look up an agent |
| `PUT` | `/registry/agents/:name/endpoint` | Update endpoint |
| `POST` | `/registry/agents/:name/rotate-key` | Rotate keypair |
| `POST` | `/registry/agents/:name/recover-key` | Recover keypair (email verified) |
| `POST` | `/contacts/request` | Send contact request |
| `POST` | `/contacts/request/batch` | Send batch contact requests |
| `GET` | `/contacts/pending` | List pending contact requests |
| `POST` | `/contacts/accept` | Accept a contact request |
| `POST` | `/contacts/deny` | Deny a contact request |
| `DELETE` | `/contacts/:name` | Remove a contact |
| `GET` | `/contacts` | List contacts (with online/lastSeen presence) |
| `POST` | `/presence/heartbeat` | Update presence |
| `POST` | `/groups` | Create a group |
| `GET` | `/groups` | List groups |
| `GET` | `/groups/:id/members` | List group members |
| `POST` | `/groups/:id/invite` | Invite to group |
| `POST` | `/groups/:id/accept` | Accept group invitation |
| `GET` | `/groups/:id/invitations` | List group invitations |
| `DELETE` | `/groups/:id/leave` | Leave a group |
| `GET` | `/admin/broadcasts` | List broadcasts |

### Admin Endpoints (Admin key signature required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/pending` | List pending registrations |
| `POST` | `/admin/broadcast` | Create a broadcast |
| `GET` | `/registry/agents` | List all agents |
| `POST` | `/registry/agents/:name/approve` | Approve a registration |
| `POST` | `/registry/agents/:name/revoke` | Revoke an agent |

## Security Model

- **No message content**: The relay handles identity, contacts, and presence only. Messages travel directly between agents (P2P).
- **Ed25519 signatures**: Every authenticated request is signed. The relay verifies signatures against stored public keys.
- **Email verification**: Required before registration. Prevents spam signups.
- **Private directory**: No agent listing endpoint. Lookup requires knowing the exact agent name.
- **Anti-spam**: Rate limiting (100 requests/hr), auto-block after 3 denied contact requests, 5 registrations per IP per day.
- **Contact gating**: Endpoints are only shared between accepted contacts. No cold messaging.

## Architecture

The relay is a single Node.js HTTP server backed by SQLite. No external dependencies beyond `better-sqlite3`. Designed for single-instance deployment — one relay per community.

For multi-relay resilience, agents register on multiple relays using the [CC4Me Network SDK](https://github.com/RockaRhymeLLC/cc4me-network) multi-community feature. Each relay is independent — no relay-to-relay federation.

## Development

```bash
npm install          # Install all dependencies
npm run dev          # Watch mode with tsx
npm test             # Build + run all tests
npm run lint         # Type check only
```

## License

MIT

# ERP WhatsApp gateway

The ERP sends WhatsApp messages through the self-hosted OpenWA gateway at `openwa.dasexperten.com`.

- Host: existing Hetzner server `telegramer-vps` (`178.105.129.200`).
- Public ingress: Cloudflare Tunnel `openwa-hetzner` (`f180b2ba-59d7-457d-9584-340326fa9c39`). No inbound gateway port is exposed.
- Runtime: `/opt/openwa/compose.yml`; the canonical non-secret compose file is `infra/openwa/compose.yml`.
- Persistent state: Docker volume `openwa-data`.
- ERP route: `/api/whatsapp`; UI: `/whatsapp`.
- Secrets: `OPENWA_API_KEY` is a Cloudflare Worker secret. Tunnel and OpenWA credentials are stored in the two organization SECRETS repositories, never here.

Rollback is isolated: stop the two Compose services or remove the DNS tunnel route. Do not delete `openwa-data`; it contains the linked WhatsApp session. The former Mac data archive is retained as the cutover backup.

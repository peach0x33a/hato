# Project Agent Guidelines

## Remote VM Deployment Rule
- **Do NOT touch, modify, restart, or deploy to the Hato instance running on the remote VM (`root@192.168.2.231` / `/opt/hato` / `/root/.hato`) without explicit user permission.**
- All code changes, builds, and tests should be performed in the local workspace first; only sync or restart the remote VM service when the user explicitly asks to deploy.

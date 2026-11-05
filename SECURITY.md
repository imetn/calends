# Security policy

Calends stores personal financial data, so we take security reports seriously.

- **Please do not open a public issue for vulnerabilities.** Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability").
- Include steps to reproduce, affected version/commit and impact. We aim to acknowledge within 72 hours.

Scope highlights: authentication (password, passkeys, sessions, rate limiting), the MCP endpoint and its tokens, the public read-only page (data masking), backup/restore, and the Docker image.

Operational advice for self-hosters: always serve over HTTPS (required for passkeys), keep the published port reachable only through your reverse proxy, make Nginx append `X-Forwarded-For`, keep `SETUP_TOKEN` secret until the password is set, and treat backups as sensitive.

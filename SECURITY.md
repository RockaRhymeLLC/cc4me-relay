# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the KithKit A2A Relay, please report it through **GitHub's private vulnerability reporting**:

1. Go to the [**Security Advisories**](https://github.com/RockaRhymeLLC/kithkit-a2a-relay/security/advisories/new) page, or click the **Security** tab on the repository and select **Report a vulnerability**.
2. Fill out the advisory form with the details listed below.

Do not open a public GitHub issue for security vulnerabilities.

Include as much detail as you can:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected versions or components
- Any suggested mitigations, if you have them

## Scope

This policy covers:

- **Relay server** — the HTTP API, agent registry, and SQLite state store
- **Authentication** — Ed25519 signature verification and email verification flow
- **Contact and presence system** — contact gating, presence heartbeats, and group management
- **Rate limiting and anti-spam** — request throttling and abuse prevention mechanisms

Out of scope: vulnerabilities in third-party dependencies (report those upstream), the KithKit A2A Agent SDK (report to that repo), or agent-to-agent P2P communication (the relay does not handle message content).

## Response Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgement | Within 48 hours |
| Initial triage and severity assessment | Within 7 days |
| Resolution or mitigation plan communicated | Depends on severity |

We will keep you informed throughout the process. Critical vulnerabilities (e.g., authentication bypass, unauthorized agent access) will be prioritized immediately.

## Disclosure

We follow coordinated disclosure. Please give us a reasonable window to remediate before publishing details publicly. We will credit researchers who report valid vulnerabilities unless they prefer to remain anonymous.

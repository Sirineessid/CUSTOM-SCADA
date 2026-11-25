# FUXA Deployment Agent

The Windows deployment agent receives authenticated site packages from the FUXA control server, keeps releases on disk, starts the target runtime, and supports rollback.

## Requirements

- Windows for IIS hosting; IP/port hosting can also run on another Node.js host.
- A Node.js installation and a FUXA runtime at `FUXA_RUNTIME_HOME`. The agent does not install or update Node.js or the FUXA runtime.
- A shared `FUXA_DEPLOYMENT_TOKEN` of at least 32 characters, configured in the control server and the agent environment. Keep it out of browser configuration and source control.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `FUXA_DEPLOYMENT_TOKEN` | Yes | Bearer token shared with the control server. |
| `FUXA_RUNTIME_HOME` | No | FUXA server directory containing `main.js`; defaults to the parent of this folder. |
| `FUXA_DEPLOYMENT_ROOT` | No | Release and deployment state directory; defaults to `_deployments` under the runtime directory. |
| `FUXA_DEPLOYMENT_AGENT_HOST` | No | Bind address; defaults to loopback without TLS and all interfaces with TLS. |
| `FUXA_DEPLOYMENT_AGENT_PORT` | No | Agent HTTP(S) port; defaults to `1882`. |
| `FUXA_DEPLOYMENT_TLS_KEY` | For remote access | Path to the agent TLS private key. |
| `FUXA_DEPLOYMENT_TLS_CERT` | For remote access | Path to the matching TLS certificate. |
| `FUXA_NODE_PATH` | No | Node.js executable used to start deployed runtimes; defaults to the agent's Node.js executable. |

The agent refuses to listen on a network interface over plain HTTP. Remote control servers must use the agent's HTTPS URL. For IP/port runtime HTTPS, the same agent key and certificate are used by the runtime.

## Start or install as a Windows service

Set the environment variables for the account that will run the agent, then start it directly:

```powershell
node .\server\deployment-agent\main.js
```

To install the Windows service from an elevated PowerShell session:

```powershell
node .\server\deployment-agent\windows-service.js install
```

Remove it with:

```powershell
node .\server\deployment-agent\windows-service.js uninstall
```

The Windows service inherits the deployment-related environment variables present during installation. Configure and protect the TLS key, certificate, runtime directory, and deployment root for that service account.

## Hosting modes

- **IP + Port:** the runtime listens on the selected port and is reachable directly. Allow the chosen port through the target firewall. HTTP is available when explicitly selected; HTTPS requires the agent TLS key and certificate.
- **IIS:** requires IIS WebAdministration, URL Rewrite, and Application Request Routing (ARR). The agent configures an IIS reverse proxy to a loopback-only runtime. For HTTPS, the selected certificate thumbprint must exist in `LocalMachine\My`.

The published runtime is separate from the control server's central account service. Configure authentication and authorization for the target runtime itself before exposing it to users; the preflight warns that central accounts are not replicated to the target.

## Releases and rollback

Each package is checksum-verified and extracted into a versioned directory below `FUXA_DEPLOYMENT_ROOT`. The current release and the previous release are recorded in `deployments.json`. Publishing saves the control-side site backup before transfer; rollback switches the target back to the previously active release.

Open **Deploy site** from the site's context menu in the editor, or use the site's **Deploy** navigation button. Configure the agent URL and hosting settings, run preflight, then publish. Remote agent access requires HTTPS and administrator permission on the control server.

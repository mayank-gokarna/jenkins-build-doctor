# Jenkins Build Doctor

Browse Jenkins jobs and pipelines from VS Code, pick a failed build, and get an **evidence-based root-cause diagnosis**: what failed, where in the log, why it probably happened, and how to fix it.

The analysis is **rule-based and runs entirely on your machine**, so you don't need an LLM or API key. AI is an optional add-on. It only runs when you turn it on, and it asks for your consent before anything is sent.

---

## Features

- **Jenkins Explorer** (activity bar). Shows a hierarchical tree of folders, multibranch pipelines, organization folders, pipelines and freestyle jobs, with each job's last build status, number and age. Expand a job to see its recent builds.
- **Search and filter.** *Search Jobs* is a fuzzy picker across all folders. *Filter Jobs* narrows the tree to matching jobs.
- **Build selection.** Choose from the build history or type a build number. *Diagnose Last Failed Build* is one click from any job.
- **Diagnosis view** contains:
  - a headline naming the **most probable root cause** and the failing stage;
  - findings split into **Confirmed** (the log or Jenkins API states the problem explicitly) and **Hypotheses** (inferred, to be verified);
  - **evidence**: the exact log lines with context, the pipeline stage and clickable line numbers that open the console log at that line;
  - **probable causes** and **numbered remediation steps** for each finding;
  - a pipeline stage strip, failing tests from the JUnit report, build parameters (sensitive values masked), SCM changes, and notes such as log truncation;
  - *Copy report as Markdown* for tickets and chat.
- **About 90 built-in rules** covering compilation (Java/Kotlin/Scala, TypeScript, .NET, C/C++, Go, Rust, Python, bundlers), tests (JUnit/Maven/Gradle, Jest/Mocha, pytest, Go, .NET), dependencies (Maven, Gradle, npm/yarn/pnpm, pip, Go, NuGet), authentication (Git, registries, cloud IAM, package repos, TLS), infrastructure (DNS, proxies, timeouts, rate limits, lost agents), resources (disk, OOM, exit 137), Kubernetes (ImagePullBackOff, CrashLoopBackOff, OOMKilled, scheduling, quotas, RBAC, rollouts, agent pods), Docker, deployment (Helm, Terraform, Ansible, AWS, CloudFormation, Argo CD, artifact publishing), SCM, Jenkinsfile/Groovy errors, quality gates, timeouts and aborts.
- **Custom rules** for your organisation's own failure signatures, set in your settings.
- **Diagnose Log in Active Editor**: analyses any console log you already have open, without connecting to Jenkins.
- **Optional AI second opinion** through the VS Code Language Model API (for example GitHub Copilot, no key needed), Amazon Bedrock, or any OpenAI-compatible endpoint.

## How diagnosis works

1. **Collect.** The extension fetches build metadata, the console log (`consoleText`), the JUnit report (`testReport/api/json`) and pipeline stages (`wfapi/describe`) in parallel. Each step can be cancelled. Logs larger than the limit keep their first 1 MB and the most recent part.
2. **Clean.** It strips ANSI colours, Jenkins console annotations and timestamper prefixes, and attributes each line to its pipeline stage using the `[Pipeline] { (Stage)` markers.
3. **Redact.** It masks secrets before anything is displayed. Line numbers are preserved.
4. **Match.** Every rule's patterns are scanned across the log.
5. **Rank.** Each finding is scored on:
   - rule specificity (a compile error ranks above "script returned exit code 1"),
   - proximity to the **failure point** (the first generic failure marker),
   - whether it falls inside the stage Jenkins reports as failed,
   - its number of occurrences,
   - its certainty.

   Generic markers are shown separately as *failure markers*: symptoms, not causes. The ranking reasons appear under each finding.
6. **Fall back.** If nothing matches, the lines just before the failure point are shown, marked as a hypothesis.

**Confirmed vs hypothesis.** A *confirmed* finding means the log or API explicitly reports that error, for example `cannot find symbol` or `ImagePullBackOff`. A *hypothesis* is an inference, for example "exit code 137 → probably out of memory". The *probable causes* listed under any finding are always hypotheses, ordered by likelihood.

## Installation

### From a VSIX

```bash
npm ci
npm run package                       # produces jenkins-build-doctor-0.1.0.vsix
code --install-extension jenkins-build-doctor-0.1.0.vsix
```

### From source (development)

```bash
npm ci
npm run compile
```

Then open the folder in VS Code and press **F5** (*Run Extension*).

Requires VS Code 1.95 or later. There are no runtime npm dependencies.

## Configuration

### 1. Connect to Jenkins

Run **Jenkins: Configure Connection** from the Command Palette, or click the button in the empty Jenkins view, then enter:

| Prompt | Notes |
|---|---|
| Server URL | Include any context path, e.g. `https://ci.example.com/jenkins/`. Plain `http://` to a non-local host triggers a warning. |
| Username | The Jenkins user ID. |
| API token | Create one in Jenkins under **your name → Security → API Token → Add new token**. Use a token, not your password. |

The connection is validated (server reachable, Jenkins detected, user authenticated) before anything is saved. The URL and username go to user settings. **The token is stored only in VS Code SecretStorage**, which uses the OS keychain. **Jenkins: Sign Out** removes it.

If the server uses a certificate from an internal CA and verification fails, you'll be offered the option to disable verification for that server. The better fix is to install the CA in the OS trust store, which VS Code honours through `http.systemCertificates`.

### 2. Required Jenkins permissions

The extension is **read-only**: it only issues `GET` requests, so no CSRF crumb is needed. The account needs:

- **Overall/Read**
- **Job/Read**, on the folders and jobs you want to see
- Console output and test reports are covered by Job/Read. Stage data requires the *Pipeline: Stage View* plugin (optional; without it the stage strip is skipped).

No build, configure or admin permissions are required. A dedicated read-only service account is ideal.

### 3. Settings

| Setting | Default | Description |
|---|---|---|
| `jenkinsBuildDoctor.server.url` / `.username` | — | Set by *Configure Connection*. |
| `jenkinsBuildDoctor.server.strictSSL` | `true` | TLS certificate verification. |
| `jenkinsBuildDoctor.server.requestTimeoutSeconds` | `30` | Per-request timeout. |
| `jenkinsBuildDoctor.jobs.buildHistoryLimit` | `25` | Builds shown per job. |
| `jenkinsBuildDoctor.jobs.searchMaxDepth` / `.searchMaxJobs` | `6` / `5000` | Limits for the search index crawl. |
| `jenkinsBuildDoctor.analysis.maxLogSizeMB` | `15` | Maximum console log downloaded per build. |
| `jenkinsBuildDoctor.analysis.contextLines` | `3` | Context lines around evidence. |
| `jenkinsBuildDoctor.analysis.customRules` | `[]` | Your own rules (see below). |
| `jenkinsBuildDoctor.security.redactConsoleOutput` | `true` | Redact secrets in displayed logs and reports. |
| `jenkinsBuildDoctor.security.additionalRedactionPatterns` | `[]` | Extra regexes to mask. |
| `jenkinsBuildDoctor.ai.*` | provider `none` | Optional AI settings (see below). |

#### Custom rules

```jsonc
"jenkinsBuildDoctor.analysis.customRules": [
  {
    "id": "vault-sealed",
    "title": "Vault is sealed",
    "category": "infrastructure",
    "pattern": "Vault is sealed|code=503.*sys/seal-status",
    "certainty": "confirmed",
    "weight": 90,
    "summary": "Secrets could not be read: {0}",
    "causes": ["The Vault cluster was restarted and not unsealed."],
    "remediation": ["Ask the platform team to unseal Vault, then re-run the build."]
  }
]
```

In `summary`, `{0}` is the whole match, `{1}`, `{2}`… are capture groups, and `{g}` is the first non-empty group. Invalid rules are reported in the diagnosis notes; they don't stop the analysis.

## Optional AI analysis

The extension doesn't use AI unless you configure it. Run **Jenkins: Configure AI Provider…** and choose one:

| Provider | What you need |
|---|---|
| **VS Code language model** | An installed LM provider such as GitHub Copilot, signed in. **No API key.** VS Code also asks you once to allow this extension to use the model. |
| **Amazon Bedrock** | Region and model ID (default `anthropic.claude-opus-5-5`; any Converse-capable model or inference profile ID/ARN works), plus one of: a Bedrock API key, AWS access keys (stored in SecretStorage), or `AWS_BEARER_TOKEN_BEDROCK` / `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` in the VS Code process environment. The IAM principal needs `bedrock:InvokeModel` on the model. |
| **OpenAI-compatible** | A base URL such as `http://localhost:11434/v1` for Ollama, or an internal gateway / Azure OpenAI / vLLM / LiteLLM endpoint, a model name, and an optional API key (SecretStorage). |

Then click **Ask AI** in a diagnosis. Safeguards:

- Nothing is sent automatically. Every first use per provider and endpoint shows a modal stating what will be sent and where. You choose **Send Once**, **Always Allow for This Provider**, or **Preview Data**, which opens the exact prompt for review.
- Only a **bounded excerpt** is sent: rule findings, failing tests, log windows around the evidence, and the log tail, capped by `ai.maxPromptChars`. It is always redacted, even when display redaction is turned off.
- The AI answer is labelled *AI-generated* and must state whether its conclusion is confirmed or a hypothesis.
- **Jenkins: Revoke AI Data-Sharing Consent** clears stored consents.

The engine is modular. To add a provider, implement `LlmProvider` (`src/analysis/llm/provider.ts`) and register it in `AiService.createProvider`.

## Security and privacy

- **Credentials.** Credentials are never hardcoded or written to settings, logs or global state. The Jenkins token, Bedrock keys and API keys live in SecretStorage.
- **Same-origin only.** Credentials are sent only to the configured Jenkins origin. Job URLs are built from the configured base URL, not from URLs that Jenkins returns. Redirects to another origin are refused, which also exposes SSO interception.
- **Redaction.** The redactor covers private keys, credentials in URLs, Authorization headers, AWS/GitHub/GitLab/Slack/Google/npm/LLM tokens, JWTs, connection strings, `--password` style CLI flags, `docker login -p`, and `password=` / `"apiKey": …` style assignments, plus the configured Jenkins token itself and your extra patterns. Masking is best effort, so review data before sharing it.
- **Minimal retention.** Logs are kept in memory only, while a diagnosis panel or log document is open, and are released when it closes. Nothing is written to disk.
- **Response validation.** Every Jenkins response is validated at runtime. Malformed entries are dropped, HTML login pages are detected, and response sizes are capped.
- **Webview hardening.** The webview uses a strict Content-Security-Policy with a script nonce, all log text is HTML-escaped, there are no remote resources, and incoming messages are validated against an allowlist.
- **Structured logs.** The *Jenkins Build Doctor* output channel produces structured, redacted logs (**Jenkins: Show Extension Logs**). Set the level with *Developer: Set Log Level…*.

## Commands

| Command | Where |
|---|---|
| Jenkins: Configure Connection / Test Connection / Sign Out | Palette, view menu |
| Jenkins: Refresh, Filter Jobs…, Clear Filter, Search Jobs… | View title bar |
| Jenkins: Diagnose Build… | Palette, build items (inline and context menu), click a build |
| Jenkins: Diagnose Last Failed Build, Select Build to Diagnose… | Job context menu / inline |
| Jenkins: Open Console Output, Open in Browser, Copy URL | Context menus |
| Jenkins: Diagnose Log in Active Editor | Palette; uses the selection if there is one |
| Jenkins: Configure AI Provider…, Revoke AI Data-Sharing Consent | Palette |
| Jenkins: Show Extension Logs | Palette |

## Development

```text
src/
  core/        http (abort, timeouts, size caps, head+tail truncation, same-origin redirects), redaction, structured logger
  jenkins/     REST client, runtime response validation, URL building, types
  analysis/    preprocessing, rule engine, rules/ (data-driven), engine (ranking), llm/ (prompt, SigV4, Bedrock, OpenAI-compatible)
  report/      HTML (webview) and Markdown rendering (pure functions)
  vscode/      settings, SecretStorage, tree view, job index, diagnosis panel, log documents, AI service + consent, controller
test/
  unit/        mocha tests in plain Node (no VS Code needed)
  integration/ mock Jenkins server; client+engine end-to-end tests; extension-host tests (suite/)
```

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # unit + Jenkins integration tests against a mock server (plain Node)
npm run test:vscode   # extension-host tests in a downloaded VS Code
                      # (set VSCODE_EXECUTABLE to use an installed one instead)
npm run package       # build the .vsix
```

Everything under `src/core`, `src/jenkins`, `src/analysis` and `src/report` is free of `vscode` imports, so the engine can be reused, for example from a CLI or in a Jenkins post-build step.

## Limitations

- Stage attribution relies on the standard `[Pipeline] { (Name)` markers. Heavily interleaved parallel output may be attributed to the enclosing stage.
- Pipeline stage status requires the Pipeline Stage View plugin (`wfapi`).
- Matrix job configurations are not listed individually.
- Rules are heuristics. When they disagree with what you see, add a custom rule or use *Ask AI*.

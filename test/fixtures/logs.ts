/** Realistic (abridged) Jenkins console logs used by unit and integration tests. */

export const MAVEN_COMPILE_FAILURE = `Started by user Alice
Obtained Jenkinsfile from git https://git.example.com/team/backend.git
[Pipeline] Start of Pipeline
[Pipeline] node
Running on agent-linux-01 in /var/jenkins/workspace/team-a/backend-build
[Pipeline] {
[Pipeline] stage
[Pipeline] { (Checkout)
[Pipeline] checkout
 > git fetch --tags --force --progress -- https://git.example.com/team/backend.git
Checking out Revision 3f2a9c1d (refs/remotes/origin/main)
[Pipeline] }
[Pipeline] // stage
[Pipeline] stage
[Pipeline] { (Build)
[Pipeline] sh
+ mvn -B clean verify
[INFO] Scanning for projects...
[INFO] Building backend 1.4.0-SNAPSHOT
[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ backend ---
[INFO] Compiling 42 source files to /var/jenkins/workspace/team-a/backend-build/target/classes
[ERROR] COMPILATION ERROR :
[ERROR] /var/jenkins/workspace/team-a/backend-build/src/main/java/com/example/OrderService.java:[57,24] cannot find symbol
  symbol:   method calculateTotal(java.util.List<com.example.Item>)
  location: class com.example.PriceCalculator
[INFO] 1 error
[INFO] BUILD FAILURE
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project backend: Compilation failure
[ERROR] -> [Help 1]
[Pipeline] }
[Pipeline] // stage
[Pipeline] stage
[Pipeline] { (Test)
Stage "Test" skipped due to earlier failure(s)
[Pipeline] }
[Pipeline] // stage
[Pipeline] }
[Pipeline] // node
[Pipeline] End of Pipeline
ERROR: script returned exit code 1
Finished: FAILURE
`;

export const K8S_IMAGE_PULL = `Started by timer
[Pipeline] Start of Pipeline
[Pipeline] node
[Pipeline] {
[Pipeline] stage
[Pipeline] { (Deploy)
[Pipeline] withKubeConfig
[Pipeline] {
[Pipeline] sh
+ kubectl apply -f k8s/deployment.yaml -n prod
deployment.apps/payments configured
+ kubectl rollout status deployment/payments -n prod --timeout=120s
Waiting for deployment "payments" rollout to finish: 1 old replicas are pending termination...
+ kubectl get pods -n prod
NAME                        READY   STATUS             RESTARTS   AGE
payments-7c9d8f6b5d-x2k4q   0/1     ImagePullBackOff   0          2m
  Warning  Failed     2m    kubelet  Failed to pull image "registry.example.com/payments:1.9.3": rpc error: code = NotFound desc = manifest unknown
error: deployment "payments" exceeded its progress deadline
[Pipeline] }
[Pipeline] }
[Pipeline] // stage
[Pipeline] }
[Pipeline] End of Pipeline
ERROR: script returned exit code 1
Finished: FAILURE
`;

export const NPM_E404 = `+ npm ci
npm ERR! code E404
npm ERR! 404 Not Found - GET https://registry.npmjs.org/@acme%2fui-kit - Not found
npm ERR! 404
npm ERR! 404  '@acme/ui-kit@^3.2.0' is not in this registry.
npm ERR! A complete log of this run can be found in: /home/jenkins/.npm/_logs/debug.log
script returned exit code 1
Finished: FAILURE
`;

export const GIT_AUTH = `Started by GitHub push by bob
 > git fetch --no-tags --force --progress -- https://github.com/acme/app.git +refs/heads/main:refs/remotes/origin/main # timeout=10
ERROR: Error fetching remote repo 'origin'
hudson.plugins.git.GitException: Failed to fetch from https://github.com/acme/app.git
stderr: remote: Support for password authentication was removed on August 13, 2021.
fatal: Authentication failed for 'https://github.com/acme/app.git/'
ERROR: Error fetching remote repo 'origin'
Finished: FAILURE
`;

export const OOM_137 = `[Pipeline] { (Integration Tests)
+ ./gradlew integrationTest
> Task :integrationTest
Killed
script returned exit code 137
[Pipeline] }
Finished: FAILURE
`;

export const GROOVY_ERROR = `Started by user admin
org.codehaus.groovy.control.MultipleCompilationErrorsException: startup failed:
WorkflowScript: 23: unexpected token: } @ line 23, column 1.
   }
   ^

1 error

	at org.codehaus.groovy.control.ErrorCollector.failIfErrors(ErrorCollector.java:309)
Finished: FAILURE
`;

export const CREDENTIALS_MISSING = `[Pipeline] withCredentials
ERROR: Could not find credentials entry with ID 'nexus-deploy'
[Pipeline] // withCredentials
Finished: FAILURE
`;

export const SUCCESS = `Started by user alice
[Pipeline] echo
Hello
Finished: SUCCESS
`;

export const UNKNOWN_FAILURE = `Started by user alice
+ ./custom-tool --run
custom-tool: widget calibration drift exceeded tolerance (frobnicator=42)
the operation could not complete
Finished: FAILURE
`;

export const WITH_SECRETS = `+ curl -H "Authorization: Bearer abcDEF123456ghiJKL" https://api.example.com
+ git clone https://deploy:hunter2secret@git.example.com/repo.git
export DB_PASSWORD=SuperSecret123
AWS key AKIAIOSFODNN7EXAMPLE used
token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAx
abc
-----END RSA PRIVATE KEY-----
after key
`;

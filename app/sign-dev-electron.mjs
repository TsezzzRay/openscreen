// Gives the development Electron binary a stable code identity.
//
// `swift run` produced a bare executable, so macOS attributed its permissions —
// and those of the Agent child it spawned — to the terminal that launched it,
// and screen capture worked with no setup. Electron's development binary is a
// real application bundle, so macOS attributes permissions to the bundle
// instead. Out of the box that bundle is `com.github.Electron`, ad-hoc signed,
// with a signature that does not cover its Info.plist, and a Screen Recording
// grant cannot stick to it.
//
// Signing it once with a real certificate fixes that for good: the binary is
// downloaded by npm and never rebuilt, so one grant lasts until Electron is
// reinstalled — and this script runs before every `npm run dev` to cover that.
//
// Without an identity the script does nothing and development still works; the
// Agent simply answers from text with no screen attached.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const BUNDLE = "node_modules/electron/dist/Electron.app";
const IDENTITY_FILE = ".signing-identity";

function signingIdentity() {
  const fromEnv = process.env["OPENSCREEN_SIGNING_IDENTITY"]?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(IDENTITY_FILE)) return undefined;
  const fromFile = readFileSync(IDENTITY_FILE, "utf8").trim();
  return fromFile.length > 0 ? fromFile : undefined;
}

// codesign writes its report to stderr whether or not it succeeds, so read it
// from there in both paths. Reading stdout instead silently reports "unsigned"
// for an already-signed bundle, which would re-sign it on every launch and
// invalidate the permission granted against the previous signature.
function currentSignature(bundle) {
  // Verbosity 2 is where codesign starts printing the Authority chain.
  const result = spawnSync("codesign", ["-d", "--verbose=2", bundle], {
    encoding: "utf8",
  });
  return `${result.stderr ?? ""}${result.stdout ?? ""}`;
}

const name = signingIdentity();
if (name === undefined) {
  process.stdout.write(
    `No signing identity configured, so ${BUNDLE} keeps its default identity ` +
      "and screen capture will not start in a development launch. Put a " +
      `certificate name in ${IDENTITY_FILE} or OPENSCREEN_SIGNING_IDENTITY ` +
      "to enable it; see README.md.\n",
  );
  process.exit(0);
}

if (!existsSync(BUNDLE)) {
  process.stdout.write(`${BUNDLE} is missing; run npm ci first.\n`);
  process.exit(0);
}

// Re-signing is not free and, more importantly, a changed signature would
// invalidate the permission already granted against it. Leave a correctly
// signed bundle alone.
if (currentSignature(resolve(BUNDLE)).includes(`Authority=${name}`)) {
  process.stdout.write(`${BUNDLE} is already signed by ${name}.\n`);
  process.exit(0);
}

try {
  execFileSync(
    "codesign",
    ["--force", "--sign", name, "--deep", resolve(BUNDLE)],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  process.stdout.write(`Signed ${BUNDLE} with ${name}.\n`);
  process.stdout.write(
    "Grant Screen Recording to Electron once in System Settings; it persists " +
      "from then on.\n",
  );
} catch {
  process.stdout.write(
    `Could not sign ${BUNDLE} with ${name}. Development still works without ` +
      "screen capture.\n",
  );
}

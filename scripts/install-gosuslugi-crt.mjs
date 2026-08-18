import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT_URL = "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";
const SUB_URL = "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function run(cmd, args, { sudoIfNeeded = true } = {}) {
  const needSudo = sudoIfNeeded && process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
  const fullCmd = needSudo ? "sudo" : cmd;
  const fullArgs = needSudo ? [cmd, ...args] : args;
  const res = spawnSync(fullCmd, fullArgs, { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`Command failed: ${fullCmd} ${fullArgs.join(" ")}`);
}

async function downloadTo(url, outFile) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outFile, buf);
}

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-gosuslugi-crt-"));
  return dir;
}

async function main() {
  const dir = tmpDir();
  const rootPath = path.join(dir, "russian_trusted_root_ca_pem.crt");
  const subPath = path.join(dir, "russian_trusted_sub_ca_pem.crt");
  const outDir = process.env.ML_CERTS_DIR ?? path.join(os.homedir(), ".config", "multi-lanchat", "certs");
  const outPem = path.join(outDir, "russian-trustedca.pem");

  log("Downloading MinCifry certificates from gosuslugi.ru…");
  await downloadTo(ROOT_URL, rootPath);
  await downloadTo(SUB_URL, subPath);
  fs.mkdirSync(outDir, { recursive: true });
  const chainPem = `${fs.readFileSync(rootPath, "utf8")}\n${fs.readFileSync(subPath, "utf8")}\n`;
  fs.writeFileSync(outPem, chainPem, "utf8");

  if (process.platform === "linux") {
    const candidates = [
      "/usr/local/share/ca-certificates",
      "/usr/share/ca-certificates",
      "/etc/ca-certificates/trust-source/anchors",
      "/etc/pki/ca-trust/source/anchors",
    ];
    const dir = candidates.find((d) => fs.existsSync(d)) ?? "";
    if (!dir) throw new Error("No known CA certificates anchor directory found for this Linux distribution.");

    // update-ca-certificates expects .crt under /usr/local/share/ca-certificates (Debian/Ubuntu family)
    // For other families we still copy to the first existing anchor dir and try their updater.
    const dstRoot = path.join(dir, path.basename(rootPath));
    const dstSub = path.join(dir, path.basename(subPath));
    fs.copyFileSync(rootPath, dstRoot);
    fs.copyFileSync(subPath, dstSub);

    if (fs.existsSync("/usr/sbin/update-ca-certificates") || fs.existsSync("/usr/bin/update-ca-certificates")) {
      log("Updating CA store (update-ca-certificates)…");
      run("update-ca-certificates", [], { sudoIfNeeded: true });
    } else if (fs.existsSync("/usr/bin/update-ca-trust") || fs.existsSync("/usr/sbin/update-ca-trust")) {
      log("Updating CA store (update-ca-trust)…");
      run("update-ca-trust", ["extract"], { sudoIfNeeded: true });
    } else {
      log("CA store update command not found automatically. Please update manually after copying certificates.");
    }

    log("Done. Certificates installed.");
    log(`Node/OpenSSL: you can force trust via NODE_EXTRA_CA_CERTS=${outPem}`);
    return;
  }

  if (process.platform === "darwin") {
    if (process.env.ML_SKIP_SYSTEM_KEYCHAIN === "1") {
      log(`Skip System keychain update (ML_SKIP_SYSTEM_KEYCHAIN=1).`);
      log(`Node/OpenSSL: you can force trust via NODE_EXTRA_CA_CERTS=${outPem}`);
      return;
    }
    const keychain = "/Library/Keychains/System.keychain";
    log("Adding certificates to macOS System keychain…");
    run("security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", keychain, rootPath], { sudoIfNeeded: true });
    run("security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", keychain, subPath], { sudoIfNeeded: true });
    log("Done. Certificates installed.");
    log(`Node/OpenSSL: you can force trust via NODE_EXTRA_CA_CERTS=${outPem}`);
    return;
  }

  if (process.platform === "win32") {
    // Use PowerShell; requires admin rights.
    const ps = [
      `Set-StrictMode -Version Latest`,
      `$root = ${JSON.stringify(rootPath)};`,
      `$sub = ${JSON.stringify(subPath)};`,
      `Import-Certificate -FilePath $root -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null;`,
      `Import-Certificate -FilePath $sub -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null;`,
      `Write-Host "Done. Certificates installed."`,
    ].join("");

    log("Importing certificates into Windows LocalMachine\\Root store…");
    run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { sudoIfNeeded: false });
    log(`Node/OpenSSL: you can force trust via NODE_EXTRA_CA_CERTS=${outPem}`);
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

main().catch((e) => {
  console.error(`install-gosuslugi-crt failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

// Helper output is appended at the end by the caller's terminal.


import { readFile, writeFile } from "node:fs/promises";
import packageJson from "../package.json" with { type: "json" };
const version = packageJson.version;
const sums = await readFile(new URL("../dist/SHA256SUMS", import.meta.url), "utf8");
const checksum = (target: string) => {
  const line = sums.split("\n").find((line) => line.endsWith(`  tcache-${target}`));
  const hash = line?.split("  ")[0];
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Missing checksum: ${target}`);
  return hash;
};
const url = `https://github.com/res-fortuitae/turborepo-remote-cache-api/releases/download/cli-v${version}`;
const formula = `class Tcache < Formula
  desc "Self-hosted Turborepo remote cache CLI"
  homepage "https://github.com/res-fortuitae/turborepo-remote-cache-api"
  version "${version}"
  on_macos do
    on_arm do
      url "${url}/tcache-darwin-arm64"
      sha256 "${checksum("darwin-arm64")}"
    end
    on_intel do
      url "${url}/tcache-darwin-x64"
      sha256 "${checksum("darwin-x64")}"
    end
  end
  on_linux do
    on_arm do
      url "${url}/tcache-linux-arm64"
      sha256 "${checksum("linux-arm64")}"
    end
    on_intel do
      url "${url}/tcache-linux-x64"
      sha256 "${checksum("linux-x64")}"
    end
  end
  def install
    bin.install Dir["tcache-*"][0] => "tcache"
  end
  test do
    assert_match "tcache v${version}", shell_output("#{bin}/tcache --version")
  end
end
`;
await writeFile(new URL("../dist/tcache.rb", import.meta.url), formula);

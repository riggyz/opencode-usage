import { expect, test } from "bun:test"
import manifest from "../package.json"

test("Git installs do not trigger npm dependency preparation", () => {
  // Pacote prepares Git dependencies with any of these scripts, even with ignoreScripts.
  const scripts: Record<string, string> = manifest.scripts
  for (const name of ["build", "preinstall", "install", "postinstall", "prepack", "prepare"]) {
    expect(scripts[name]).toBeUndefined()
  }
  expect("workspaces" in manifest).toBe(false)
  expect(scripts["build:gui"]).toBe("vite build")
})

test("the desktop bundle is present and included in the package", async () => {
  expect(manifest.files).toContain("dist")
  expect(manifest.exports["./gui-experimental"]).toBe("./dist/gui-experimental.cjs")
  expect(await Bun.file(new URL("../dist/gui-experimental.cjs", import.meta.url)).exists()).toBe(true)
})

import type { SandboxInstance } from "../../src/types";

/** A fake sandbox plus the in-memory workspace it ended up with. */
export interface ExecutingSandbox {
  /** The binding-shaped instance to hand to the code under test. */
  instance: SandboxInstance;
  /** The workspace as it stands: path → string (as written) or bytes (as decoded). */
  files: Map<string, string | Uint8Array>;
  /** Every command `run` was asked for, in order. */
  commands: string[];
}

/**
 * A sandbox stand-in with a real (in-memory) workspace that actually
 * *executes* the binary-decode script it is given.
 *
 * The usual `vi.fn()` sandbox records calls, which is enough to assert that a
 * manifest was written — but the bugs worth catching at this boundary are
 * about what the workspace looks like *after* the script has run: the decode
 * script overwrites the files named in the manifest and then deletes the
 * manifest and itself, so a helper staged on top of a tracked file destroys
 * that file, and no assertion over write calls alone shows it. Running the
 * emitted source (rather than re-implementing it here) also means the path
 * baked into the script is the one under test, not one the test assumed.
 *
 * Any command that is not `node <path>` succeeds silently; the tests that use
 * this care about the tree, not about npm.
 */
export function makeExecutingSandbox(): ExecutingSandbox {
  const files = new Map<string, string | Uint8Array>();
  const commands: string[] = [];

  const fsShim = {
    readFileSync(path: string, encoding?: string): string | Uint8Array {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: no such file or directory: ${path}`);
      if (encoding === "utf8") {
        return typeof value === "string" ? value : new TextDecoder().decode(value);
      }
      return value;
    },
    writeFileSync(path: string, content: string | Uint8Array): void {
      files.set(path, content);
    },
    unlinkSync(path: string): void {
      if (!files.has(path)) throw new Error(`ENOENT: no such file or directory: ${path}`);
      files.delete(path);
    },
  };

  // The decode script's only other host dependency. Base64 in, bytes out —
  // exactly the slice of `Buffer` the script uses.
  const bufferShim = {
    from(value: string, encoding: string): Uint8Array {
      if (encoding !== "base64") throw new Error(`Unsupported encoding: ${encoding}`);
      return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    },
  };

  const instance: SandboxInstance = {
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    run: async (command: string) => {
      commands.push(command);
      if (!command.startsWith("node ")) return { exitCode: 0, stdout: "", stderr: "" };
      const scriptPath = command.slice("node ".length);
      const source = files.get(scriptPath);
      if (typeof source !== "string") {
        return { exitCode: 1, stdout: "", stderr: `Cannot find module '${scriptPath}'` };
      }
      try {
        // The emitted source is compiled and run as-is, so the paths baked
        // into it are the ones under test. `fs` and `Buffer` are the only
        // host surfaces it touches; both are backed by the map above.
        const script = new Function("require", "__filename", "Buffer", source) as unknown as (
          req: (name: string) => unknown,
          filename: string,
          buffer: typeof bufferShim,
        ) => void;
        script(
          (name: string) => {
            if (name !== "fs") throw new Error(`Cannot find module '${name}'`);
            return fsShim;
          },
          scriptPath,
          bufferShim,
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: String(error) };
      }
    },
    destroy: async () => {},
  };

  return { instance, files, commands };
}

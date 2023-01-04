import { execa } from "execa";
import chalk from "chalk";
import { promises } from "fs";
import { fileURLToPath } from "url";
import { dirname, relative } from "path";
import { findUp } from "find-up";
import { log, logError } from "./logger.js";

export async function run(nodeProcess: NodeJS.Process = process) {
  const benchmarkOutputPath: string | undefined = nodeProcess.env.BENCHMARK_OUTPUT_PATH;
  if (!benchmarkOutputPath) {
    logError(chalk.bold.red(`The expected environment variable BENCHMARK_OUTPUT_PATH is missing`));
    nodeProcess.exit(1);
  }

  const modules: { [uri: string]: { start: number; end: number; diff: number } } = {};
  const executableIndex = nodeProcess.argv.findIndex((value) => value.includes("node-esm-benchmark"));
  let args = [...nodeProcess.argv].slice(executableIndex + 1, nodeProcess.argv.length);
  log(chalk.bold.green(`Benchmarking: ${args.join(" ")}`));
  args = ["--loader", "node-esm-benchmark", ...args];

  const task = execa("node", args, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });

  task.stdout.on("data", (message: string) => {
    const regex = /BENCHMARK_MODULE_LOAD_TIME_START(.+)BENCHMARK_MODULE_LOAD_TIME_END/;
    const matches = message.toString().match(regex);
    if (matches) {
      const payload = JSON.parse(matches[1] as string);
      log(chalk.gray(`  Module loaded: ${payload.uri}`));
      modules[payload.uri] = {
        start: payload.start,
        end: payload.end,
        diff: parseFloat(payload.end) - parseFloat(payload.start),
      };
    }
  });
  task.stderr.on("data", (message: string) => {
    nodeProcess.stderr.write(message);
  });
  await task;

  await outputProfilerFile(modules, benchmarkOutputPath);
}

async function outputProfilerFile(
  modules: { [uri: string]: { start: number; end: number; diff: number } },
  benchmarkOutputPath: string
) {
  const fileContent = {
    traceEvents: await Promise.all(
      Object.keys(modules)
        .sort()
        .map(async (uri) => {
          return {
            ...(await eventMetadata(uri)),
            ts: modules[uri]?.start,
            dur: modules[uri]?.diff,
            ph: "X",
            args: {
              ms: modules[uri]?.diff,
              uri: uri,
            },
          };
        })
    ),
    displayTimeUnit: "ms",
  };
  await promises.writeFile(benchmarkOutputPath, JSON.stringify(fileContent, null, 2));
}

type EventMetadata = {
  pid: string;
  tid?: string;
  name: string;
};

async function eventMetadata(uri: string): Promise<EventMetadata> {
  if (!uri.includes("file://")) {
    return { pid: "node", name: uri };
  }
  const path = fileURLToPath(uri);
  const packageJsonPath = (await findUp("package.json", { cwd: path })) as string;
  const packageJson = await promises.readFile(packageJsonPath);
  const packageName = JSON.parse(packageJson.toString())["name"];
  const id = `${packageName}:${relative(dirname(packageJsonPath), path)}`;
  return { pid: packageName, tid: id, name: id };
}

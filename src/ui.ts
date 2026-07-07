import chalk from "chalk";

export const log = {
  info: (msg: string) => process.stdout.write(`${chalk.blue("i")}  ${msg}\n`),
  ok: (msg: string) => process.stdout.write(`${chalk.green("+")}  ${msg}\n`),
  warn: (msg: string) => process.stdout.write(`${chalk.yellow("!")}  ${msg}\n`),
  err: (msg: string) => process.stdout.write(`${chalk.red("x")}  ${msg}\n`),
  step: (n: number, msg: string) =>
    process.stdout.write(`\n${chalk.bold.cyan(`[${n}]`)} ${chalk.bold(msg)}\n`),
  cmd: (msg: string) => process.stdout.write(`  ${chalk.dim("$")} ${msg}\n`),
  out: (msg: string) => process.stdout.write(`  ${chalk.gray(msg)}\n`),
};

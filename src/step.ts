import { select } from "@inquirer/prompts";
import chalk from "chalk";
import { log } from "./ui.js";

/**
 * Modo debug = cada paso importante se muestra y se pide confirmacion explicita.
 * Se activa con --debug en CLI o desde el TUI.
 *
 *   - Modo normal:   ejecuta directo
 *   - Modo debug:    muestra un recuadro con el plan, pregunta Y/n/abort
 *                    "Y"  -> ejecuta
 *                    "n"  -> se salta este paso (continua)
 *                    "ab" -> aborta el flujo completo
 */

let debugMode = false;

export function setDebugMode(v: boolean): void {
  debugMode = v;
}

export function isDebugMode(): boolean {
  return debugMode;
}

export function parseDebugFlag(args: string[]): boolean {
  for (const a of args) {
    if (a === "--debug" || a === "--step" || a === "-i" || a === "--interactive") {
      return true;
    }
  }
  return false;
}

export function stripDebugFlag(args: string[]): string[] {
  return args.filter(
    (a) =>
      a !== "--debug" &&
      a !== "--step" &&
      a !== "-i" &&
      a !== "--interactive"
  );
}

export type StepDecision = "y" | "n" | "abort";

export type StepContext = {
  /** Titulo corto del paso (ej: "Subir script al VPS") */
  title: string;
  /** Indice del paso, ej: 3/8 */
  index?: { n: number; total: number };
  /** Detalles del plan - lineas que se mostraran antes de pedir confirmacion */
  plan: string[];
  /** true si el paso es de solo lectura (no se muestra abort option, auto-confirmado) */
  readOnly?: boolean;
  /** true si el paso es opcional (puede saltarse sin abortar el flujo) */
  optional?: boolean;
  /** Cuando se salta, que accion tomar. Default: skip (no hacer nada) */
  onSkip?: () => Promise<void> | void;
};

export type StepFn = () => Promise<void>;

/**
 * Confirmar antes de ejecutar un paso. En modo normal solo ejecuta.
 * En modo debug muestra el plan y pregunta.
 */
export async function confirmStep(
  ctx: StepContext,
  fn: StepFn
): Promise<StepDecision> {
  if (debugMode) {
    printStepHeader(ctx);
    const decision = await askDecision(ctx);
    if (decision === "n") {
      log.warn(`Paso saltado: ${ctx.title}`);
      if (ctx.onSkip) await ctx.onSkip();
      return "n";
    }
    if (decision === "abort") {
      log.err(`Abortado por el usuario en: ${ctx.title}`);
      throw new AbortedByUserError(ctx.title);
    }
  }
  await fn();
  if (debugMode) {
    log.ok(`OK: ${ctx.title}`);
  }
  return "y";
}

/** Solo muestra el plan y pide decision, sin ejecutar nada. */
export async function previewStep(ctx: StepContext): Promise<StepDecision> {
  printStepHeader(ctx);
  return askDecision(ctx);
}

function printStepHeader(ctx: StepContext) {
  const total = (ctx.index?.total ?? 0).toString();
  const n = (ctx.index?.n ?? 0).toString();
  const idx = total ? `  ${n}/${total}` : "";
  const w = 60;
  const line = "─".repeat(w - 2);
  process.stdout.write(`\n`);
  process.stdout.write(chalk.bold.cyan(`╭${line}╮\n`));
  process.stdout.write(
    chalk.bold.cyan("│") +
      "  " +
      chalk.bold(ctx.title.padEnd(w - 4 - idx.length)) +
      chalk.cyan(idx) +
      chalk.bold.cyan("│\n")
  );
  process.stdout.write(chalk.bold.cyan(`├${line}┤\n`));
  for (const line2 of ctx.plan) {
    const truncated = line2.length > w - 4 ? line2.slice(0, w - 5) + "…" : line2;
    process.stdout.write(
      chalk.bold.cyan("│") +
        "  " +
        truncated.padEnd(w - 4) +
        chalk.bold.cyan("│\n")
    );
  }
  process.stdout.write(chalk.bold.cyan(`╰${line}╯\n`));
}

async function askDecision(ctx: StepContext): Promise<StepDecision> {
  if (ctx.readOnly) {
    process.stdout.write(chalk.gray("  (paso informativo - se ejecuta automatico)\n"));
    return "y";
  }
  const choices: { name: string; value: StepDecision }[] = [
    { name: chalk.green("y  Si, proceder con este paso"), value: "y" },
  ];
  if (ctx.optional) {
    choices.push({
      name: chalk.yellow("n  Saltar este paso (continuar con el resto)"),
      value: "n",
    });
  }
  choices.push({
    name: chalk.red("ab  Abortar todo el flujo aqui"),
    value: "abort",
  });
  const ans = await select<StepDecision>({
    message: "Confirmar paso?",
    choices,
    pageSize: 5,
  });
  return ans;
}

/** Error que el caller puede detectar para abort limpio. */
export class AbortedByUserError extends Error {
  constructor(public step: string) {
    super(`Abortado por el usuario en el paso: ${step}`);
    this.name = "AbortedByUserError";
  }
}

export function isAborted(e: unknown): boolean {
  return e instanceof AbortedByUserError;
}

/** Resetea el modo debug (util en el TUI para cambiar de modo entre flujos). */
export function resetDebugMode(): void {
  debugMode = false;
}

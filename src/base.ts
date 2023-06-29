import { Command, Flags as OclifFlags, Interfaces } from "@oclif/core";
import * as winston from "winston";

export type Flags<T extends typeof Command> = Interfaces.InferredFlags<(typeof BaseCommand)["baseFlags"] & T["flags"]>;
export type Args<T extends typeof Command> = Interfaces.InferredArgs<T["args"]>;

export abstract class BaseCommand<T extends typeof Command> extends Command {
	static usage = "<%= command.id %> [options]";

	// define flags that can be inherited by any command that extends BaseCommand
	static flags = {
		help:  OclifFlags.help({
			char:        "h",
			description: "show this help message",
			helpGroup:   "Global",
		}),
		debug: OclifFlags.boolean({
			char:        "d",
			description: "enable debug logging",
			helpGroup:   "Global",
		}),
	};

	protected flags!: Flags<T>;
	protected args!: Args<T>;

	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore
	protected logger: winston.Logger;

	public async init(): Promise<void> {
		await super.init();

		const {
			args,
			flags,
		} = await this.parse({
			flags:  { ...this.ctor.flags },
			args:   this.ctor.args,
			strict: this.ctor.strict,
		});

		this.flags = flags as Flags<T>;
		this.args = args as Args<T>;

		this.logger = winston.createLogger({
			level:      this.flags.debug ? "debug" : "info",
			format:     winston.format.combine(
				winston.format.cli(),
				winston.format.timestamp({
					format: "DD-MM-YYYY HH:mm:ss.SSS",
				}),
				winston.format.splat(),
				winston.format.printf(({
					level,
					message,
					timestamp,
				}) => {
					return `[${level}] [${timestamp}]: ${message}`;
				}),
			),
			transports: [ new winston.transports.Console() ],
		});
	}

	public log(message: string, ...others: any[]): void {
		this.logger.info(`${message} ${others.map(() => "%s").join(" ")}`, ...others);
	}

	public logDebug(message: string, ...others: any[]): void {
		this.logger.debug(`${message} ${others.map(() => "%s").join(" ")}`, ...others);
	}

	public warn(input: string | Error, ...others: any[]): string | Error {
		this.logger.warn(
			input instanceof Error
				? `${input.message} ${others.map(() => "%s").join(" ")}`
				: `${input} ${others.map(() => "%s").join(" ")}`,
			...others,
		);

		return input;
	}

	public error(input: string | Error, ...others: any[]): never {
		this.logger.error(
			input instanceof Error
				? `${input.message} ${others.map(() => "%s").join(" ")}`
				: `${input} ${others.map(() => "%s").join(" ")}`,
			...others,
		);

		throw input instanceof Error ? input : new Error(input);
	}

	protected async catch(err: Error & { exitCode?: number }): Promise<any> {
		// add any custom logic to handle errors from the command
		// or simply return the parent class error handling
		if (/Missing required .*/.test(err.message)) {
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore
			await this.ctor.run([ "--help" ]);
			return;
		}

		return super.catch(err);
	}
}

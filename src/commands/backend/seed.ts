import { bootstrap, TemplateService, UserService } from "@aetheria/common";
import { Args } from "@oclif/core";
import { readFile } from "node:fs/promises";
import { BaseCommand } from "../../base";
import { parallelize } from "../../helpers";

interface SeedFile {
	$schema: string;
	items: {
		type: string;
		[x: string]: any;
	}[];
}

export class Seed extends BaseCommand<typeof Seed> {
	static summary = "Seed the database";

	static examples = [ "<%= config.bin %> <%= command.id %>" ];

	static flags = {
		...BaseCommand.flags,
	};

	static args = {
		seed: Args.file({
			description: "JSON file to seed the database with",
		}),
	};

	protected template_service!: TemplateService;
	protected user_service!: UserService;

	public async run(): Promise<void> {
		const app = await bootstrap({
			runas_cli:             true,
			enable_error_logging:  this.flags.debug,
			enable_native_logging: this.flags.debug,
		});
		await app.init();

		this.template_service = app.get<TemplateService>(TemplateService);
		this.user_service = app.get<UserService>(UserService);

		await this.requireMissingArguments();
		this.log("Starting seeding ...");

		await this.seed(await this.readSeedFile());

		await app.close();
		this.log("Seeding completed successfully");
	}

	private async requireMissingArguments() {
		const inquirer = require("inquirer");

		if (!this.args.seed) {
			this.args.seed = await inquirer.prompt([
				{
					type:     "input",
					name:     "seed",
					message:  "Enter the path to the seed file:",
					validate: (input: string) => {
						return input.length > 0;
					},
				},
			]);
		}
	}

	private async readSeedFile() {
		return JSON.parse(await readFile(this.args.seed as string, "utf-8")) as SeedFile;
	}

	/**
	 * Seed templates
	 * @returns {Promise<void>} A promise that resolves when the task is done
	 * @param item - The item to seed
	 */
	private async seedTemplates(item: any) {
		try {
			const template = await this.template_service.findByName(item.name);

			// If the user already exists, skip
			if (template) {
				this.warn(`Template '${item.name}' already exists, skipping.`);

				return;
			}
		}
		catch (error: any) {
			if (error?.message === "Template not found.") {
				this.log(`Creating template '${item.name}' ...`);

				const created_template = await this.template_service.create({
					name: item.name,
					html: item.html,
					css:  item.css,
					project_data:
					      typeof item.project_data === "string" ? JSON.parse(item.project_data) : item.project_data,
				});

				this.log(`Created template '${created_template.name}' with id '${created_template.id}'.`);

				return;
			}

			throw error;
		}
	}

	/**
	 * Seed users
	 * @returns {Promise<void>} A promise that resolves when the task is done
	 * @param item - The item to seed
	 */
	private async seedUsers(item: any) {
		try {
			const user = await this.user_service.findByEmail(item.email);

			// If the user already exists, skip
			if (user) {
				this.warn(`User '${item.email}' already exists, skipping.`);

				return;
			}
		}
		catch (error: any) {
			if (error?.message === "User not found") {
				this.log(`Creating user '${item.email}' ...`);

				const created_user = await this.user_service.create({
					email:    item.email,
					password: item.password,
					name:     item.name,
				});

				this.log(`Created user '${created_user.email}' with id '${created_user.id}'.`);

				return;
			}

			throw error;
		}
	}

	/**
	 * Seed the database
	 * @returns {Promise<void>} A promise that resolves when the task is done
	 * @param parsed_seed - The parsed seed file
	 */
	private async seed(parsed_seed: SeedFile) {
		const { items } = parsed_seed;

		await parallelize(
			...items.map(async (item) => {
				switch (item.type) {
					case "template":
						return this.seedTemplates(item);
					case "user":
						return this.seedUsers(item);
					default:
						return Promise.resolve();
				}
			}),
		);
	}
}

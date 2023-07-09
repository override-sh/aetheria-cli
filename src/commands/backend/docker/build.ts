import { Args, Flags } from "@oclif/core";
import { spawn } from "node:child_process";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { BaseCommand } from "../../../base";
import { parallelize } from "../../../helpers";
import semver = require("semver/preload");

export class Build extends BaseCommand<typeof Build> {
	static summary = "Build a docker image for the backend";

	static examples = [ "<%= config.bin %> <%= command.id %>" ];

	static available_presets = [ "base" ];

	static flags = {
		...BaseCommand.flags,
		headless_folder: Flags.string({
			char:        "f",
			description: "The folder where the headless backend is located",
		}),
		build:           Flags.boolean({
			description: "Whether to build the source code before building the image",
			default:     true,
			allowNo:     true,
		}),
		publish:         Flags.boolean({
			description: "Whether to publish the image",
			default:     true,
			allowNo:     true,
		}),
		version:         Flags.string({
			char:        "v",
			description: "The version of the image to build [example: 1.0.0]",
		}),
	};

	static args = {
		image: Args.string({
			description: "The image to build",
			options:     Build.available_presets,
		}),
	};

	protected docker_folder!: string;

	public async run() {
		await this.getMissingParameters();

		await this.verifyDockerFolderPresence();

		if (this.flags.build) {
			await this.buildProject();
		}

		await this.copyDistributionFiles();
    await this.copySupportFiles();
		await this.cloneRootNestDependencies();

		await this.buildImage();
		await this.publish();
	}

	private publish() {
		if (!this.flags.publish) {
			this.warn("Skipping publish");
			return Promise.resolve();
		}

		return new Promise<void>((ok, fail) => {
			const image_tag = `${this.flags.version}-${this.args.image}`;
			const image_latest_tag = `latest-${this.args.image}`;
			const image_name = `overridesoft/aetheria-headless:`;

			const images_to_publish = [
				`${image_name}${image_tag}`,
				`${image_name}${image_latest_tag}`,
			];

			this.log(`Publishing images: ${images_to_publish.join(", ")} - this may take some time ...`);

			const child = spawn(
				images_to_publish.map((image) => `docker push ${image}`).join(" && "),
				{
					cwd:   this.docker_folder,
					shell: true,
				},
			);

			child.stdout.on("data", (data) => {
				console.log(data.toString());
			});

			child.stderr.on("data", (data) => {
				console.log(data.toString());
			});

			child.on("error", (err) => {
				this.safeError(err);
			});

			child.on("close", (code) => {
				if (code === 0) {
					this.log(`Images published successfully`);
					ok();
				}
				else {
					this.error(`Build failed with code ${code}`);
					fail();
				}
			});
		});
	}

	private buildImage() {
		return new Promise<void>((ok, fail) => {
			const image_tag = `${this.flags.version}-${this.args.image}`;
			const image_latest_tag = `latest-${this.args.image}`;
			const image_name = `overridesoft/aetheria-headless:`;

			this.log(`Building image '${image_name}${image_tag}', this may take some time ...`);

			const child = spawn(
				`docker build -t ${image_name}${image_tag} . && docker tag ${image_name}${image_tag} ${image_name}${image_latest_tag}`,
				{
					cwd:   this.docker_folder,
					shell: true,
				},
			);

			child.on("error", (err) => {
				this.safeError(err);
			});

			child.on("close", (code) => {
				if (code === 0) {
					this.log(`Image '${image_name}${image_tag}' and '${image_name}${image_latest_tag}' built successfully`);
					ok();
				}
				else {
					this.error(`Build failed with code ${code}`);
					fail();
				}
			});
		});
	}

	private async cloneRootNestDependencies() {
		this.log("Cloning root @nestjs dependencies ...");

		const resolution_path = resolve(this.flags.headless_folder as string, "package.json");
		const pjson = JSON.parse(await readFile(resolution_path, { encoding: "utf-8" }));

		const dependencies = Object.keys(pjson.dependencies)
		                           .filter((dep) => dep.startsWith("@nestjs"))
		                           .reduce((acc, dep) => {
			                           acc[dep] = pjson.dependencies[dep];

			                           return acc;
		                           }, {} as Record<string, string>);

		const image_pjson_path = resolve(
			this.docker_folder,
			"package.json",
		);
		const image_pjson = JSON.parse(await readFile(image_pjson_path, { encoding: "utf-8" }));
		image_pjson.dependencies = { ...image_pjson.dependencies, ...dependencies };

		await writeFile(image_pjson_path, JSON.stringify(image_pjson, null, 4));

		this.log("Root @nestjs dependencies cloned successfully");
	}

  private async copySupportFiles() {
    this.log("Copying support files ...");

    const files = [
      resolve(this.flags.headless_folder as string, "tailwind.css"),
      resolve(this.flags.headless_folder as string, "tailwind.config.js"),
      resolve(this.flags.headless_folder as string, "postcss.config.js"),
    ];

    await parallelize(...files.map(async (file) => {
      this.logDebug(`Copying ${file} to ${this.args.image}/${basename(file)}`);

      return cp(
        file,
        resolve(
          this.docker_folder,
          "dist",
          basename(file),
        ),
      );
    }));

    this.log("Distribution files copied successfully");
  }

	private async copyDistributionFiles() {
		this.log("Copying distribution files ...");

		const resolution_path = resolve(this.flags.headless_folder as string, "dist/apps/aetheria-backend/src");

		const files = await readdir(
			resolution_path,
			{
				withFileTypes: true,
				encoding:      "utf-8",
				recursive:     true,
			},
		);

		const files_to_copy = files.filter((dirent) => dirent.isFile() && dirent.name.endsWith(".js"));

		await parallelize(...files_to_copy.map(async (file) => {
			const clean_path = file.path.replace(resolution_path, "");

			this.logDebug(`Copying ${clean_path}${file.name} to ${this.args.image}/${clean_path}${file.name}`);

			return cp(
				resolve(file.path, file.name),
				resolve(
					this.docker_folder,
					"dist",
					clean_path,
					file.name,
				),
			);
		}));

		this.log("Distribution files copied successfully");
	}

	/**
	 * Build the project using tsc
	 * @returns {Promise<void>} A promise that resolves when the project is built
	 * @private
	 */
	private buildProject() {
		return new Promise<void>((ok, fail) => {
			this.log(`Building ${this.flags.headless_folder} ...`);

			const child = spawn("tsc", { cwd: this.flags.headless_folder });

			child.stderr.on("data", (data) => {
				this.warn(data.toString());
			});

			child.on("error", (err) => {
				this.safeError(err);
			});

			child.on("close", (code) => {
				if (code === 0) {
					this.log("Build successfully");
					ok();
				}
				else {
					this.error(`Build failed with code ${code}`);
					fail();
				}
			});
		});
	}

	private async verifyDockerFolderPresence() {
		try {
			const presets = await readdir(
				resolve(this.flags.headless_folder as string, "docker"),
				{
					withFileTypes: true,
					encoding:      "utf-8",
				},
			);

			if (!presets.every((dirent) => dirent.isDirectory() && Build.available_presets.includes(dirent.name))) {
				this.error(
					`The docker folder does not contain all the required presets: ` +
					` ${Build.available_presets.join(", ")}`,
				);
			}

			this.docker_folder = resolve(
				this.flags.headless_folder as string,
				"docker",
				this.args.image as string,
			);
		}
		catch (error: any) {
			this.error("The docker folder does not exist in the headless folder");
			this.logDebug(error.message);
		}
	}

	private async getMissingParameters() {
		await this.getHeadlessFolderIfNotSet();
		await this.getImageIfNotSet();
		await this.getVersionIfNotSet();

		return true;
	}

	private async getVersionIfNotSet() {
		if (this.flags.version && semver.valid(this.flags.version)) {
			return;
		}

		const inquirer = require("inquirer");

		const answers = await inquirer.prompt([
			{
				type:     "input",
				name:     "version",
				message:  "What version of the image is this?",
				default:  "0.0.0",
				validate: (input: string) => {
					if (semver.valid(input)) {
						return true;
					}

					return "Please enter a valid version";
				},
			},
		]);

		this.flags.version = answers.version;
	}

	private async getHeadlessFolderIfNotSet() {
		if (this.flags.headless_folder) {
			return true;
		}

		const inquirer = require("inquirer");

		const answers = await inquirer.prompt([
			{
				type:     "input",
				name:     "headless_folder",
				message:  "Where is the headless backend located?",
				default:  "../headless",
				validate: (input: string) => {
					if (input.length === 0) {
						return "Please enter a valid path";
					}

					return true;
				},
			},
		]);

		this.flags.headless_folder = answers.headless_folder;

		return true;
	}

	private async getImageIfNotSet() {
		if (this.args.image) {
			return;
		}

		const inquirer = require("inquirer");

		const answers = await inquirer.prompt([
			{
				type:    "list",
				name:    "image",
				message: "Which image do you want to build?",
				choices: Build.available_presets,
			},
		]);

		this.args.image = answers.image;
	}
}

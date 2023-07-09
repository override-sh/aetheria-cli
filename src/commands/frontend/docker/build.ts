import { Args, Flags } from "@oclif/core";
import { spawn } from "node:child_process";
import { cp, readdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BaseCommand } from "../../../base";
import { parallelize } from "../../../helpers";
import semver = require("semver/preload");

export class Build extends BaseCommand<typeof Build> {
  static summary = "Build a docker image for the backend";

  static examples = [ "<%= config.bin %> <%= command.id %>" ];

  static available_presets = [ "base" ];

  static flags = {
    ...BaseCommand.flags,
    frontend_folder: Flags.string({
      char: "f",
      description: "The folder where the frontend is located",
    }),
    build: Flags.boolean({
      description: "Whether to build the source code before building the image",
      default: true,
      allowNo: true,
    }),
    publish: Flags.boolean({
      description: "Whether to publish the image",
      default: true,
      allowNo: true,
    }),
    version: Flags.string({
      char: "v",
      description: "The version of the image to build [example: 1.0.0]",
    }),
  };

  static args = {
    image: Args.string({
      description: "The image to build",
      options: Build.available_presets,
    }),
  };

  protected docker_folder!: string;

  public async run() {
    await this.getMissingParameters();

    await this.verifyDockerFolderPresence();

    if (this.flags.build) {
      await this.buildProject();
    }

    await this.patchDistributionTree();
    await this.copyDistributionFiles();
    await this.copySupportFiles();

    await this.buildImage();
    await this.publish();
  }

  private async patchDistributionTree() {
    this.log("Should patch distribution tree?");

    const target_path = resolve(this.flags.frontend_folder as string, "dist/apps/frontend/.next/standalone");

    const files = await readdir(resolve(this.flags.frontend_folder as string, "dist/apps/frontend/.next/standalone"), {
      encoding: "utf-8",
      withFileTypes: true,
      recursive: false,
    });
    const should_not_patch = files.some((file) => file.isFile() && file.name === "server.js");

    if (should_not_patch) {
      this.log("No patching needed");
      return;
    }

    this.log("Patching distribution tree ...");

    const files_to_move = await readdir(resolve(this.flags.frontend_folder as string, "dist/apps/frontend/.next/standalone/apps/frontend"), {
      encoding: "utf-8",
      withFileTypes: true,
    });

    await parallelize(...files_to_move.map(async (file) => {
      const origin = resolve(file.path, file.name);
      const deposit = resolve(target_path, file.name);

      this.logDebug(`Moving '${origin}' to '${deposit}' ...`);

      return rename(
        origin,
        deposit,
      );
    }));

    await parallelize(...files.map(async (file) => {
      const origin = resolve(file.path, file.name);
      this.logDebug(`Removing dead code at '${origin}' ...`);

      return rm(origin, {
        force: true,
        recursive: true,
      });
    }));

    this.log("Distribution tree patched successfully");
  }

  private publish() {
    if (!this.flags.publish) {
      this.warn("Skipping publish");
      return Promise.resolve();
    }

    return new Promise<void>((ok, fail) => {
      const image_tag = `${this.flags.version}-${this.args.image}`;
      const image_latest_tag = `latest-${this.args.image}`;
      const image_name = `overridesoft/aetheria-frontend:`;

      const images_to_publish = [
        `${image_name}${image_tag}`,
        `${image_name}${image_latest_tag}`,
      ];

      this.log(`Publishing images: ${images_to_publish.join(", ")} - this may take some time ...`);

      const child = spawn(
        images_to_publish.map((image) => `docker push ${image}`).join(" && "),
        {
          cwd: this.docker_folder,
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
        } else {
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
      const image_name = `overridesoft/aetheria-frontend:`;

      this.log(`Building image '${image_name}${image_tag}', this may take some time ...`);

      const child = spawn(
        `docker build -t ${image_name}${image_tag} . && docker tag ${image_name}${image_tag} ${image_name}${image_latest_tag}`,
        {
          cwd: this.docker_folder,
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
        } else {
          this.error(`Build failed with code ${code}`);
          fail();
        }
      });
    });
  }

  private async copySupportFiles() {
    this.log("Copying support files ...");

    const files: string[] = [
      // resolve(this.flags.frontend_folder as string, "tailwind.css"),
      // resolve(this.flags.frontend_folder as string, "tailwind.config.js"),
      // resolve(this.flags.frontend_folder as string, "postcss.config.js"),
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

    const resolution_path = resolve(this.flags.frontend_folder as string, "dist/apps/frontend");

    const files = await readdir(
      resolution_path,
      {
        withFileTypes: true,
        encoding: "utf-8",
      },
    );

    await parallelize(...files.map(async (file) => {
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
        {
          recursive: true,
        },
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
      this.log(`Building ${this.flags.frontend_folder} ...`);

      const child = spawn("npx", [
        "nx",
        "run",
        "frontend:build:production",
      ], { cwd: this.flags.frontend_folder });

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
        } else {
          this.error(`Build failed with code ${code}`);
          fail();
        }
      });
    });
  }

  private async verifyDockerFolderPresence() {
    try {
      const presets = await readdir(
        resolve(this.flags.frontend_folder as string, "docker"),
        {
          withFileTypes: true,
          encoding: "utf-8",
        },
      );

      if (!presets.every((dirent) => dirent.isDirectory() && Build.available_presets.includes(dirent.name))) {
        this.error(
          `The docker folder does not contain all the required presets: ` +
          ` ${Build.available_presets.join(", ")}`,
        );
      }

      this.docker_folder = resolve(
        this.flags.frontend_folder as string,
        "docker",
        this.args.image as string,
      );
    } catch (error: any) {
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
        type: "input",
        name: "version",
        message: "What version of the image is this?",
        default: "0.0.0",
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
    if (this.flags.frontend_folder) {
      return true;
    }

    const inquirer = require("inquirer");

    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "frontend_folder",
        message: "Where is the headless backend located?",
        default: "../headless",
        validate: (input: string) => {
          if (input.length === 0) {
            return "Please enter a valid path";
          }

          return true;
        },
      },
    ]);

    this.flags.frontend_folder = answers.frontend_folder;

    return true;
  }

  private async getImageIfNotSet() {
    if (this.args.image) {
      return;
    }

    const inquirer = require("inquirer");

    const answers = await inquirer.prompt([
      {
        type: "list",
        name: "image",
        message: "Which image do you want to build?",
        choices: Build.available_presets,
      },
    ]);

    this.args.image = answers.image;
  }
}

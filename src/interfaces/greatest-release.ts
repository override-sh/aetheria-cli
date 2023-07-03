import { ReferenceCommit } from "./reference-commit";

export interface GreatestRelease {
	greatest_version: string,
	reference_commit: ReferenceCommit
}

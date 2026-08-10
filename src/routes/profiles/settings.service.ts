import { promises as fs } from "fs";
import { join } from "path";
import type { Category } from "../slicing/models";
import { AppError } from "../../middleware/error";

const BASE = process.env.DATA_PATH || join(process.cwd(), "data");

/** Does this filesystem error mean "the path isn't there"? */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Saves a setting object to a JSON file in the specified category directory.
 * Creates the directory if it doesn't exist.
 * @param category - The category directory to save the setting in.
 * @param name - The name of the setting file (without .json extension).
 * @param content - The object to be saved as JSON.
 * @returns A Promise that resolves when the file is written.
 */
export async function saveSetting(
  category: Category,
  name: string,
  content: object,
) {
  try {
    const dir = join(BASE, category);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, `${name}.json`),
      JSON.stringify(content, null, 2),
      "utf8",
    );
  } catch (error) {
    throw new AppError(
      500,
      `Failed to save settings`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Lists the names of settings files for a specified category.
 * This function reads files from the corresponding category directory,
 * filters out JSON files, and returns their base names without extensions.
 * @param category - The category to filter settings.
 * @returns A Promise that resolves to an array of file names (without .json extension)
 * or an empty array if the directory doesn't exist.
 * @throws {AppError} If the directory cannot be read.
 */
export async function listSettings(category: Category) {
  const dir = join(BASE, category);
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch (error) {
    // The directory is created lazily by the first saveSetting, so its
    // absence means "no profiles of this category yet" -- which is what the
    // doc comment above always promised and the code did not do.
    if (isNotFound(error)) return [];
    throw new AppError(
      500,
      `Failed to read settings directory`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Reads a setting from disk and parses it into an object.
 * @param category - The category directory containing the setting file.
 * @param name - The name of the setting file (without .json extension).
 * @returns A Promise that resolves to the parsed JSON content.
 * @throws {AppError} If the file cannot be read or parsed.
 */
export async function getSetting(category: Category, name: string) {
  const filepath = join(BASE, category, `${name}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(filepath, "utf8");
  } catch (error) {
    // A profile that isn't there is the caller naming one that doesn't exist,
    // not the service failing. This used to be a 500 alongside genuine read
    // failures, which meant a typo'd preset name and a broken DATA_PATH were
    // indistinguishable to anyone consuming the API.
    if (isNotFound(error)) {
      throw new AppError(
        404,
        `No ${category} profile named "${name}"`,
        `Looked for ${filepath}`,
      );
    }
    throw new AppError(
      500,
      `Failed to read setting`,
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    // The file exists but isn't usable -- a real server-side problem, and
    // worth saying so rather than reporting it as a missing profile.
    throw new AppError(
      500,
      `Profile "${name}" is not valid JSON`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Deletes a setting JSON file for the given category and name.
 * @param category - The category directory containing the setting file.
 * @param name - The name of the setting file (without .json extension).
 */
export async function deleteSetting(category: Category, name: string) {
  const filepath = join(BASE, category, `${name}.json`);
  try {
    await fs.unlink(filepath);
  } catch (error) {
    // Same split as getSetting: deleting something that was never there is a
    // 404, not a service failure.
    if (isNotFound(error)) {
      throw new AppError(
        404,
        `No ${category} profile named "${name}"`,
        `Looked for ${filepath}`,
      );
    }
    throw new AppError(
      500,
      `Failed to delete setting`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

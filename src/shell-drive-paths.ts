/**
 * Git Bash (MSYS2) and Cygwin spell a Windows drive as a path component:
 * `/c/Users/x` and `/cygdrive/c/Users/x` both name `C:/Users/x`. Node's path
 * module on Windows reads them as `\c\Users\x` on the current drive, so a
 * write the shell sends to `C:\Users\x` would be checked at another place.
 */

const DRIVE_COMPONENT = /^\/(?:cygdrive\/)?([A-Za-z])(\/|$)/;

/**
 * The length of the drive spelling at the start of `value` and its drive
 * letter, when `value` starts with one on Windows.
 */
export function shellDrivePrefix(
  value: string,
  platform: NodeJS.Platform = process.platform
): { length: number; letter: string } | undefined {
  if (platform !== "win32") return undefined;
  const match = DRIVE_COMPONENT.exec(value);
  if (!match) return undefined;
  return { length: match[0].length, letter: (match[1] as string).toUpperCase() };
}

/** A shell path as the platform reads it: `/c/Users` becomes `C:/Users` on Windows. */
export function nativeShellPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const drive = shellDrivePrefix(value, platform);
  return drive ? `${drive.letter}:/${value.slice(drive.length)}` : value;
}

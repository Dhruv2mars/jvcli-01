const EXEC_BITS = 0o111;

export function modeIsExecutable(mode: number): boolean {
  return (mode & EXEC_BITS) !== 0;
}

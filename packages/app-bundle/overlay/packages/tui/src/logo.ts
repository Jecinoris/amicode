// Terminal form of the Amicode mark. The face is the 21×10 pixel picture.
// Each pixel is two cells wide, because a terminal cell is about twice as tall
// as it is wide. The `go` pair is the upstream background watermark and is not
// the home logo.
const pixel = (row: string) => [...row].map((cell) => cell + cell).join("")
const rows = [
  "█████████       █████████",
  "█████████       █████████",
  "█████████       █████████",
  "█████████       █████████",
  "█████████████████████████",
  "█████████████████████████",
  "██                     ██",
  "██   █  ██  █  ██  █   ██",
  "██  █  █  █ █ █  █  █  ██",
  "██ █   █  █ █ █  █   █ ██",
  "██  █  █  █ █ █  █  █  ██",
  "██   █  ██  █  ██  █   ██",
  "██                     ██",
  "██        █   █        ██",
  "██         ███         ██",
  "██                     ██",
  "█████████████████████████",
  "█████████████████████████",
  "█████████       █████████",
  "█████████       █████████",
  "█████████       █████████",
  "█████████       █████████",
].map(pixel)

export const logo = {
  rows,
  // Kept so a left/right consumer still draws the mark once, on the bright side.
  left: rows.map(() => ""),
  right: rows,
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"

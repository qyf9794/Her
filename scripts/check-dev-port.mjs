import { execFileSync } from "node:child_process";
import net from "node:net";

const host = "127.0.0.1";
const port = 5174;

const server = net.createServer();

server.once("error", (error) => {
  if (error.code !== "EADDRINUSE") {
    console.error(`Unable to check ${host}:${port}: ${error.message}`);
    process.exit(1);
  }

  console.error(`Renderer dev port ${host}:${port} is already in use.`);
  console.error("Stop the process below, then run `npm run dev` again.");
  console.error("");

  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    console.error(output || "(lsof did not report a listening process.)");
  } catch {
    console.error(`Run: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  }

  process.exit(1);
});

server.once("listening", () => {
  server.close(() => {
    process.exit(0);
  });
});

server.listen(port, host);

// The in-memory Messaging adapter passes the port's contract (decision 0003, #376).
import { MemoryMessaging } from "../hooks/core/adapters/memory/messaging.ts";
import { messagingContract } from "./contracts/messaging.ts";

messagingContract("memory", () => ({ port: new MemoryMessaging(), ref: "issue#5", other: "pr#7" }));

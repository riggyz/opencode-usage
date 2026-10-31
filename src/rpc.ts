import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { Snapshot } from "./model"
import { QuotaConnection } from "./connections"

export const Usage = Rpc.define({
  id: "riggyz.usage",
  events: {},
  methods: {
    codexConnections: { input: z.object({}), output: z.array(QuotaConnection) },
    selectCodexConnection: {
      input: z.object({ id: z.string() }),
      output: z.object({ selected: z.boolean() }),
    },
    claudeDiagnostics: {
      input: z.object({}),
      output: z.object({ requests: z.number(), responses: z.number(), bound: z.number(), quota: z.number() }),
    },
    snapshot: {
      input: z.object({ refresh: z.boolean().optional() }),
      output: Snapshot,
    },
  },
})

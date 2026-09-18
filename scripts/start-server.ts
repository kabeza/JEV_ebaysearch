import { startServer } from '../src/server/index'

const port = Number(process.env.PORT ?? 3001)
await startServer(port)

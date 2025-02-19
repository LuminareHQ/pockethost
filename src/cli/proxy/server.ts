import {
  DAEMON_PORT,
  DefaultSettingsService,
  IPCIDR_LIST,
  IS_DEV,
  MOTHERSHIP_PORT,
  SETTINGS,
} from '$constants'
import { forEach } from '@s-libs/micro-dash'
import cors from 'cors'
import express, { ErrorRequestHandler } from 'express'
import 'express-async-errors'
import fs from 'fs'
import http from 'http'
import https from 'https'

import { createProxyMiddleware } from 'http-proxy-middleware'
import { createIpWhitelistMiddleware } from './cidr'
import { createVhostProxyMiddleware } from './createVhostProxyMiddleware'

DefaultSettingsService(SETTINGS)

const PROD_ROUTES = {
  'pockethost-central.pockethost.io': `http://localhost:${MOTHERSHIP_PORT()}`,
}
const DEV_ROUTES = {
  'mail.pockethost.lvh.me': `http://localhost:${1080}`,
  'pockethost-central.pockethost.lvh.me': `http://localhost:${MOTHERSHIP_PORT()}`,
  'app.pockethost.lvh.me': `http://localhost:${5174}`,
  'superadmin.pockethost.lvh.me': `http://localhost:${5175}`,
  'pockethost.lvh.me': `http://localhost:${8080}`,
}
const hostnameRoutes = IS_DEV() ? DEV_ROUTES : PROD_ROUTES

// Create Express app
const app = express()

app.use(cors())

// Use the IP blocker middleware
app.use(createIpWhitelistMiddleware(IPCIDR_LIST()))

forEach(hostnameRoutes, (target, host) => {
  app.use(createVhostProxyMiddleware(host, target, IS_DEV()))
})

app.get(`/_api/health`, (req, res, next) => {
  res.json({ status: 'ok' })
  res.end()
})

// Fall-through
const handler = createProxyMiddleware({
  target: `http://localhost:${DAEMON_PORT()}`,
})
app.all(`*`, (req, res, next) => {
  const method = req.method
  const fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl

  console.log(`${method} ${fullUrl} -> ${`http://localhost:${DAEMON_PORT()}`}`)

  handler(req, res, next)
})

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  res.status(500).send(err.toString())
}
app.use(errorHandler)

if (IS_DEV()) {
  http.createServer(app).listen(80, () => {
    console.log('HTTP server running on port 80')
  })
} else {
  // HTTPS server options
  const httpsOptions = {
    key: fs.readFileSync(
      '/home/pockethost/pockethost/ssl/cloudflare-privkey.pem',
    ),
    cert: fs.readFileSync(
      '/home/pockethost/pockethost/ssl/cloudflare-origin.pem',
    ),
  }

  // Create HTTPS server
  https.createServer(httpsOptions, app).listen(443, () => {
    console.log('HTTPS server running on port 443')
  })
}

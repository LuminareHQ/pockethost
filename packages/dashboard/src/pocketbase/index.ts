import { browser } from '$app/environment'
import { PUBLIC_APP_DB, PUBLIC_APP_DOMAIN, PUBLIC_APP_PROTOCOL } from '$src/env'
import { logger } from '@pockethost/common'
import {
  createPocketbaseClient,
  type PocketbaseClient,
} from './PocketbaseClient'

export const client = (() => {
  let clientInstance: PocketbaseClient | undefined
  return () => {
    if (!browser) throw new Error(`PocketBase client not supported in SSR`)
    if (clientInstance) return clientInstance
    const { info } = logger()
    info(`Initializing pocketbase client`)
    const url = `${PUBLIC_APP_PROTOCOL}://${PUBLIC_APP_DB}.${PUBLIC_APP_DOMAIN}`
    clientInstance = createPocketbaseClient({ url })
    return clientInstance
  }
})()

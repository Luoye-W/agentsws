/**
 * WP398（docs/106 §13 A8）：demo 里的 Amazon 词库替身——不起浏览器、不连 Amazon。
 *
 * - 联想词：几页录好的样子（种子词 `portable power station` 本身 + 几个字母），其余字母回空表；
 * - Listing 文本：自家一条（演示品牌）+ 三家竞品各一两条（竞品名与演示品牌档案里那三家一致；标题 / 五点是现编的）。
 *
 * 合进 WP394 / WP396 之后，demo 里这两份换成那两单的替身读到的页。
 */
import type { AmazonListingText } from '@agentsws/contracts'
import type { AmazonAutocompleteReader } from '@agentsws/server'

const AT = '2026-10-18T01:00:00.000Z'

const SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  'portable power station': [
    'portable power station',
    'portable power station for camping',
    'portable power station with solar panel',
    'jackery portable power station',
    'portable power station 1000w',
  ],
  'portable power station a': [
    'portable power station ac outlet',
    'portable power station app control',
  ],
  'portable power station c': ['portable power station camping', 'portable power station cpap'],
  'portable power station f': [
    'portable power station fast charging',
    'portable power station for home backup',
  ],
  'portable power station l': [
    'portable power station lifepo4',
    'portable power station lightweight',
  ],
  'portable power station s': [
    'portable power station solar generator',
    'portable power station small',
    'ecoflow portable power station',
  ],
  'portable power station w': [
    'portable power station with wheels',
    'portable power station wireless charging',
  ],
}

export function demoAmazonAutocompleteReader(): AmazonAutocompleteReader {
  return {
    async suggest({ prefix }) {
      return { status: 'ok', suggestions: [...(SUGGESTIONS[prefix] ?? [])] }
    },
  }
}

const competitor = (
  id: string,
  name: string,
  asin: string,
  title: string,
  bullets: string[],
): AmazonListingText => ({
  side: 'competitor',
  competitor_id: id,
  competitor: name,
  brand: name,
  asin,
  marketplace: 'US',
  title,
  bullets,
  read_at: AT,
})

/** 自家一条 + 竞品五条（演示用；ASIN 是编的）。 */
export const DEMO_AMAZON_LISTINGS: readonly AmazonListingText[] = [
  {
    side: 'own',
    asin: 'B0DEMOOWN1',
    marketplace: 'US',
    brand: 'Nordvolt',
    title:
      'Nordvolt Portable Power Station 1000W, 1024Wh LiFePO4 Battery Backup, 3 AC Outlets, Fast Charging for Camping and Road Trips',
    bullets: [
      'BIG CAPACITY: 1024Wh keeps a car fridge running through a weekend trip.',
      'FAST CHARGING: 0–80% in about one hour from a wall outlet.',
      'LIGHT TO CARRY: foldable handle, about 10 kg.',
    ],
    read_at: AT,
  },
  competitor(
    'demo_ecoflow',
    'EcoFlow',
    'B0DEMOECO1',
    'EcoFlow Portable Power Station 1024Wh, LiFePO4 Battery, Pure Sine Wave AC Outlets, Solar Generator for Home Backup, Camping, RV',
    ['Expandable capacity with an extra battery.', 'App control over WiFi and Bluetooth.'],
  ),
  competitor(
    'demo_ecoflow',
    'EcoFlow',
    'B0DEMOECO2',
    'EcoFlow Solar Generator with 220W Solar Panel, Portable Power Station for Camping, Home Backup',
    ['UPS function switches in under 30 ms.'],
  ),
  competitor(
    'demo_jackery',
    'Jackery',
    'B0DEMOJAC1',
    'Jackery Portable Power Station 1070Wh, Solar Generator with Pure Sine Wave AC Outlets, Home Backup for Camping, RV, Emergency',
    ['Quiet operation for camping and RV trips.', 'Works with Jackery SolarSaga panels.'],
  ),
  competitor(
    'demo_bluetti',
    'BLUETTI',
    'B0DEMOBLU1',
    'BLUETTI Portable Power Station, 1152Wh LiFePO4 Battery Backup, Pure Sine Wave Inverter, Solar Generator for Home Backup',
    ['UPS function for home backup.', 'App control and expandable capacity.'],
  ),
  competitor(
    'demo_bluetti',
    'BLUETTI',
    'B0DEMOBLU2',
    'BLUETTI Solar Generator with Wheels, Portable Power Station for RV, Camping, Emergency',
    [],
  ),
]

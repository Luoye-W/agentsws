/**
 * WP398：几份录好的 Amazon Listing 文本（标题 + 五点），品牌名都是编的。
 * 三家竞品（Voltway 两个 ASIN、Ridgeline、Pedalux）+ 自家（Nordride）一个 ASIN；英国站另有一家。
 */
import type { AmazonListingText } from '@agentsws/contracts'

const at = '2026-10-18T08:00:00.000Z'

export const OWN: AmazonListingText = {
  side: 'own',
  asin: 'B0OWN00001',
  marketplace: 'US',
  brand: 'Nordride',
  title: 'Nordride Electric Bike for Adults, 750W Motor, 28MPH Commuter E-Bike with 48V Battery',
  bullets: [
    'POWERFUL MOTOR: 750W peak motor climbs hills with ease.',
    'LONG RANGE: up to 50 miles per charge with pedal assist.',
    'COMFORT: suspension fork and wide saddle for city commuting.',
  ],
  read_at: at,
}

export const COMPETITORS: AmazonListingText[] = [
  {
    side: 'competitor',
    competitor_id: 'c_voltway',
    competitor: 'Voltway',
    asin: 'B0VOLT0001',
    marketplace: 'US',
    title:
      'Voltway Electric Bike for Adults, 750W Fat Tire Electric Bike with Removable Battery, Hydraulic Disc Brakes',
    bullets: [
      'REMOVABLE BATTERY: 48V 15Ah removable battery charges on or off the bike.',
      'FAT TIRE: 4" fat tires for sand, snow and all terrain riding.',
      'Works with Ridgeline racks and most fenders.',
    ],
    read_at: at,
  },
  {
    side: 'competitor',
    competitor_id: 'c_voltway',
    competitor: 'Voltway',
    asin: 'B0VOLT0002',
    marketplace: 'US',
    title: 'Voltway Folding Electric Bike, Removable Battery, Fat Tire Ebike for Adults',
    read_at: at,
  },
  {
    side: 'competitor',
    competitor_id: 'c_ridgeline',
    competitor: 'Ridgeline',
    asin: 'B0RIDG0001',
    marketplace: 'US',
    title: 'Ridgeline Electric Mountain Bike, Removable Battery, Hydraulic Disc Brakes, Step-Thru Frame',
    bullets: ['Fat tire option for all terrain trails.', 'Removable battery locks to the frame.'],
    read_at: at,
  },
  {
    side: 'competitor',
    competitor_id: 'c_pedalux',
    competitor: 'Pedalux',
    asin: 'B0PEDL0001',
    marketplace: 'US',
    title: 'Pedalux Step-Thru Electric Bike with Removable Battery and Hydraulic Disc Brakes',
    bullets: ['Step-thru frame for easy mounting.'],
    read_at: at,
  },
  {
    side: 'competitor',
    competitor_id: 'c_uk',
    competitor: 'Brollyway',
    asin: 'B0UKUK0001',
    marketplace: 'GB',
    title: 'Brollyway Electric Bike, Torque Sensor, Belt Drive',
    read_at: at,
  },
]

export const KNOWN_BRANDS = ['Nordride', 'Voltway', 'Ridgeline', 'Pedalux', 'Brollyway']

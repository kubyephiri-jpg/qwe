import React, { useRef, useEffect } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import polyline from '@mapbox/polyline';
import {
  buildRoute, projectOnRoute, pointAt, bearingAt, sliceFrom, bearingBetween, metersBetween, turnToward,
  type RouteModel,
} from '@/utils/routeFollow';

import {
  abicyclebDataUri, abicycleblDataUri, abicyclerDataUri,
  amotorbikebDataUri, amotorbikeblDataUri, amotorbikerDataUri,
  abusbDataUri, abusblDataUri, abusgDataUri, abuswDataUri,
  acarbDataUri, acarblDataUri, acargDataUri, acarrDataUri, acarwDataUri,
  aclosedbDataUri, aclosedblDataUri, aclosedgDataUri, aclosedrDataUri, aclosedwDataUri,
  aopenbDataUri, aopenblDataUri, aopengDataUri, aopenrDataUri, aopenwDataUri,
  atruckbDataUri, atruckblDataUri, atruckgDataUri, atruckrDataUri, atruckwDataUri,
} from './vehicleIconsBase64';

// Johannesburg default center
const DEFAULT_LAT = -15.3875;
const DEFAULT_LNG = 28.3228;

const VEHICLE_IMAGE_MAP: Record<string, Record<string, string>> = {
  bicycle: { b: abicyclebDataUri, bl: abicycleblDataUri, r: abicyclerDataUri },
  motorbike: { b: amotorbikebDataUri, bl: amotorbikeblDataUri, r: amotorbikerDataUri },
  bus: { b: abusbDataUri, bl: abusblDataUri, g: abusgDataUri, w: abuswDataUri },
  xxl: { b: abusbDataUri, bl: abusblDataUri, g: abusgDataUri, w: abuswDataUri },
  economy: { b: acarbDataUri, bl: acarblDataUri, g: acargDataUri, r: acarrDataUri, w: acarwDataUri },
  car: { b: acarbDataUri, bl: acarblDataUri, g: acargDataUri, r: acarrDataUri, w: acarwDataUri },
  truck: { b: aclosedbDataUri, bl: aclosedblDataUri, g: aclosedgDataUri, r: aclosedrDataUri, w: aclosedwDataUri },
  closed_truck: { b: aclosedbDataUri, bl: aclosedblDataUri, g: aclosedgDataUri, r: aclosedrDataUri, w: aclosedwDataUri },
  open_truck: { b: aopenbDataUri, bl: aopenblDataUri, g: aopengDataUri, r: aopenrDataUri, w: aopenwDataUri },
  refrigerated_truck: { b: atruckbDataUri, bl: atruckblDataUri, g: atruckgDataUri, r: atruckrDataUri, w: atruckwDataUri },
};
const DEFAULT_VEHICLE = VEHICLE_IMAGE_MAP.economy.b;

export interface DemandZone {
  id: string; name: string; lat: number; lng: number; radiusM: number;
  percent: number; level: 'high' | 'medium' | 'low'; color: string;
}

// Circle as a polygon (works on every WebView, no extra plugin).
const circlePolygon = (lat: number, lng: number, radiusM: number, steps = 48): [number, number][] => {
  const out: [number, number][] = [];
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    out.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
};

// picture name (from utils/vehicleIcon) -> image, e.g. 'abicyclebl' = blue bicycle
const ICON_BY_NAME: Record<string, string> = {
  abicycleb: abicyclebDataUri, abicyclebl: abicycleblDataUri, abicycler: abicyclerDataUri,
  amotorbikeb: amotorbikebDataUri, amotorbikebl: amotorbikeblDataUri, amotorbiker: amotorbikerDataUri,
  abusb: abusbDataUri, abusbl: abusblDataUri, abusg: abusgDataUri, abusw: abuswDataUri,
  acarb: acarbDataUri, acarbl: acarblDataUri, acarg: acargDataUri, acarr: acarrDataUri, acarw: acarwDataUri,
  aclosedb: aclosedbDataUri, aclosedbl: aclosedblDataUri, aclosedg: aclosedgDataUri, aclosedr: aclosedrDataUri, aclosedw: aclosedwDataUri,
  aopenb: aopenbDataUri, aopenbl: aopenblDataUri, aopeng: aopengDataUri, aopenr: aopenrDataUri, aopenw: aopenwDataUri,
  atruckb: atruckbDataUri, atruckbl: atruckblDataUri, atruckg: atruckgDataUri, atruckr: atruckrDataUri, atruckw: atruckwDataUri,
  aletwende1: acargDataUri, // no separate Aletwende picture bundled in this app
};

export interface MapMarker {
  id: string;
  type: string; // pickup | dropoff | stop | store
  lat: number;
  lng: number;
}

interface DriverMapProps {
  polyline?: string;
  trimmedPolyline?: string;
  vehiclePosition?: { lat: number; lng: number; heading: number };
  vehicleType?: string;
  vehicleColor?: string;
  vehicleIcon?: string;
  zones?: DemandZone[];
  markers?: MapMarker[];
  arrivalTime?: string | null;
  arrivalPosition?: { lat: number; lng: number } | null;
  // When true a trip is active: the map shows the route (fitBounds) and disables
  // the 20s idle auto-recenter. When false it centers on the vehicle on load and
  // auto-recenters after 20s idle. The user can always zoom/pan freely.
  hasActiveTrip?: boolean;
  // false = keep centring on the driver but hide the vehicle (driver is offline)
  showVehicle?: boolean;
  onMapReady?: () => void;
  // Called when the driver has really left the route (so the app can ask the backend for a new one)
  onOffRoute?: (lat: number, lng: number) => void;
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

// Per-vehicle-type rotation offset (deg). Icons are authored north-up, so 0
// means heading 0 renders correctly. Mirror of DriverMapHtml.ts.
const VEHICLE_ROTATION_OFFSET: Record<string, number> = {
  bicycle: 0,
  motorbike: 0,
  economy: 0,
  car: 0,
  truck: 0,
  closed_truck: 0,
  open_truck: 0,
  refrigerated_truck: 0,
  bus: 0,
  xxl: 0,
};

const IDLE_RECENTER_MS = 20000;
const DEFAULT_FOLLOW_ZOOM = 16;

export default function DriverMap({
  polyline: encodedPolyline,
  vehiclePosition,
  vehicleType,
  vehicleColor,
  vehicleIcon,
  zones,
  markers,
  arrivalTime,
  arrivalPosition,
  hasActiveTrip,
  showVehicle,
  onMapReady,
  onOffRoute,
}: DriverMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const isReadyRef = useRef(false);

  // Keep the decoded route immutable; derive each trimmed view from it.
  const fullCoordsRef = useRef<[number, number][]>([]);
  const currentCoordsRef = useRef<[number, number][]>([]);

  // Vehicle marker state
  const vehicleMarkerRef = useRef<maplibregl.Marker | null>(null);
  const vehicleImgRef = useRef<HTMLImageElement | null>(null);
  const vehicleAnimRef = useRef<number | null>(null);
  const currentRotationRef = useRef<number | null>(null);
  const smoothedHeadingRef = useRef<number | null>(null);
  const lastVehicleHeadingRef = useRef(0);
  const routeProgressRef = useRef(0);
  const lastVehicleTypeRef = useRef<string | undefined>(undefined);
  const routeRef = useRef<RouteModel | null>(null);
  const sAnimRef = useRef(0); // metres along the route where the vehicle is drawn right now
  const lastLineAtRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const lastGpsAtRef = useRef(0);
  const lastGpsPosRef = useRef<{ lat: number; lng: number } | null>(null);
  const rotTargetRef = useRef<number | null>(null); // compass heading we want
  const offRouteRef = useRef({ count: 0, since: 0, lastAskAt: 0 });
  const headingAnchorRef = useRef<{ lat: number; lng: number } | null>(null);
  const onOffRouteRef = useRef(onOffRoute);
  useEffect(() => { onOffRouteRef.current = onOffRoute; });

  // Map of active markers keyed by id
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});

  // Arrival "Arrive by ..." card marker
  const arrivalCardRef = useRef<maplibregl.Marker | null>(null);

  // ---- Camera / interaction state ----
  const lastVehicleLatLngRef = useRef<{ lat: number; lng: number } | null>(null);
  const didInitialCenterRef = useRef(false);
  const lastUserInteractionRef = useRef(0);
  const hasActiveTripRef = useRef(false);
  const zonesActiveRef = useRef(false);
  const zonesFittedRef = useRef(false);

  // Keep the trip-active flag in a ref the idle timer can read. Reset the idle
  // clock on entering a trip so we don't recenter the instant it ends.
  useEffect(() => {
    hasActiveTripRef.current = !!hasActiveTrip;
    if (hasActiveTrip) lastUserInteractionRef.current = Date.now();
  }, [hasActiveTrip]);

  // Turn the vehicle picture toward rotTargetRef. It turns at a limited speed (so it never snaps or
  // looks bent) and always the short way round. maxStepDeg = 1e6 means "jump straight there".
  const stepRotation = (maxStepDeg: number) => {
    const img = vehicleImgRef.current;
    const map = mapRef.current;
    const target = rotTargetRef.current;
    if (!img || !map || target === null || !Number.isFinite(target)) return;
    const want = target - map.getBearing();
    const cur = currentRotationRef.current;
    const next = cur === null || maxStepDeg >= 1e5 ? want : turnToward(cur, want, maxStepDeg);
    currentRotationRef.current = next;
    img.style.transform = `rotate(${next}deg)`;
  };

  // Create / update / remove the arrival card pill marker
  const createArrivalCard = (time: string) => {
    const wrapper = document.createElement('div');
    wrapper.style.width = 'fit-content';
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.alignItems = 'center';
    wrapper.style.pointerEvents = 'none';

    const pill = document.createElement('div');
    pill.style.background = '#5B2EFF';
    pill.style.color = '#fff';
    pill.style.fontFamily = '-apple-system, system-ui, sans-serif';
    pill.style.fontSize = '14px';
    pill.style.fontWeight = '700';
    pill.style.padding = '8px 14px';
    pill.style.borderRadius = '9999px';
    pill.style.whiteSpace = 'nowrap';
    pill.style.boxShadow = '0 2px 8px rgba(0,0,0,0.25)';
    pill.textContent = `Arrive by ${time}`;

    const pointer = document.createElement('div');
    pointer.style.width = '0';
    pointer.style.height = '0';
    pointer.style.borderLeft = '6px solid transparent';
    pointer.style.borderRight = '6px solid transparent';
    pointer.style.borderTop = '7px solid #5B2EFF';
    pointer.style.marginTop = '-1px';

    wrapper.appendChild(pill);
    wrapper.appendChild(pointer);
    return wrapper;
  };

  // ---- Init map once ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [DEFAULT_LNG, DEFAULT_LAT],
      zoom: 14,
      attributionControl: false,
    });

    mapRef.current = map;

    map.on('load', () => {
      isReadyRef.current = true;
      onMapReady?.();
    });

    // Treat gesture-driven moves as interactions (e.originalEvent is set only on
    // user gestures, not programmatic camera moves) so idle-recenter backs off.
    const markInteraction = (e: any) => {
      if (e && e.originalEvent) lastUserInteractionRef.current = Date.now();
    };
    map.on('movestart', markInteraction);
    map.on('zoomstart', markInteraction);
    map.on('rotatestart', markInteraction);
    map.on('rotate', () => stepRotation(1e6));
    map.on('dragstart', markInteraction);

    // Idle auto-recenter: no active trip + 20s without interaction -> ease back.
    const idleTimer = setInterval(() => {
      if (hasActiveTripRef.current) return;
      if (zonesActiveRef.current) return; // demand map is open: do not pull the camera back
      if (!didInitialCenterRef.current || !lastVehicleLatLngRef.current) return;
      if (Date.now() - lastUserInteractionRef.current >= IDLE_RECENTER_MS) {
        lastUserInteractionRef.current = Date.now();
        map.easeTo({
          center: [lastVehicleLatLngRef.current.lng, lastVehicleLatLngRef.current.lat],
          zoom: DEFAULT_FOLLOW_ZOOM,
          duration: 800,
        });
      }
    }, 1000);

    return () => {
      if (vehicleAnimRef.current) cancelAnimationFrame(vehicleAnimRef.current);
      clearInterval(idleTimer);
      Object.values(markersRef.current).forEach((m) => m.remove());
      markersRef.current = {};
      map.remove();
      mapRef.current = null;
      isReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Draw / clear polyline + fit bounds ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      if (encodedPolyline) {
        const decoded = polyline.decode(encodedPolyline); // [[lat, lng], ...]
        const coords = decoded.map((p) => [p[1], p[0]]) as [number, number][];
        if (coords.length < 2) return;
        const hadRoute = !!routeRef.current;
        const route = buildRoute(coords);
        routeRef.current = route;
        fullCoordsRef.current = coords;
        offRouteRef.current = { count: 0, since: 0, lastAskAt: offRouteRef.current.lastAskAt };

        // Where is the vehicle on this route? Draw the line only from there forward, so a re-sent or
        // re-routed line never shows the part behind the vehicle.
        let s = 0;
        const mk = vehicleMarkerRef.current?.getLngLat();
        const here = mk ? { lat: mk.lat, lng: mk.lng } : lastVehicleLatLngRef.current;
        if (here) {
          const pr = projectOnRoute(route, here.lng, here.lat, 0, route.total + 1);
          if (pr.off <= 60) s = pr.s;
        }
        sAnimRef.current = s;
        const drawCoords = sliceFrom(route, s);
        currentCoordsRef.current = drawCoords;

        const data: GeoJSON.Feature = {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: drawCoords },
        };
        const src = map.getSource('route-source') as maplibregl.GeoJSONSource | undefined;
        if (src) {
          src.setData(data);
        } else {
          map.addSource('route-source', { type: 'geojson', data });
          map.addLayer({
            id: 'route-layer',
            type: 'line',
            source: 'route-source',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#5B2EFF', 'line-width': 5 },
          });
        }

        // Frame the whole route only when a route first appears. A re-route in the middle of a trip must
        // NOT move the camera away from the driver.
        if (!hadRoute) {
          const bounds = new maplibregl.LngLatBounds();
          coords.forEach((c) => bounds.extend(c as [number, number]));
          if (!bounds.isEmpty()) {
            map.fitBounds(bounds, {
              padding: { top: 100, bottom: 320, left: 60, right: 60 },
              maxZoom: 15,
            });
          }
        }
      } else {
        routeRef.current = null;
        if (map.getLayer('route-layer')) map.removeLayer('route-layer');
        if (map.getSource('route-source')) map.removeSource('route-source');
        currentCoordsRef.current = [];
        fullCoordsRef.current = [];
        offRouteRef.current = { count: 0, since: 0, lastAskAt: offRouteRef.current.lastAskAt };
      }
    };

    if (isReadyRef.current) {
      apply();
    } else {
      map.once('load', apply);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encodedPolyline]);

  // Hide the vehicle while offline (the map still centres on the driver).
  useEffect(() => {
    const marker = vehicleMarkerRef.current;
    if (marker) marker.getElement().style.display = showVehicle === false ? 'none' : '';
  }, [showVehicle, vehiclePosition]);

  // ---- Move the vehicle ----
  // On the route: snapped to it and moved ALONG its shape at an even speed, facing the road ahead, with the
  // line trimmed to the vehicle on every frame. Off the route: moved straight to the GPS point, facing the
  // direction of travel, and (after a few seconds) the app is asked for a new route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !vehiclePosition) return;

    const SNAP_M = 30; // closer than this to the road => draw on the road
    const OFF_ROUTE_M = 40; // further than this => really off the route
    const TURN_DEG_PER_MS = 0.25;
    const JUMP_M = 80; // after the app was asleep the vehicle is far behind: jump, do not race across the map

    const run = () => {
      const { lat, lng } = vehiclePosition;
      lastVehicleTypeRef.current = vehicleType;
      const typeMap = VEHICLE_IMAGE_MAP[vehicleType || 'economy'] || VEHICLE_IMAGE_MAP.economy;
      const imgUrl = (vehicleIcon && ICON_BY_NAME[vehicleIcon]) || typeMap[vehicleColor || 'b'] || typeMap.b || DEFAULT_VEHICLE;

      lastVehicleLatLngRef.current = { lat, lng };

      const centerOnce = () => {
        if (didInitialCenterRef.current || !lastVehicleLatLngRef.current) return;
        didInitialCenterRef.current = true;
        lastUserInteractionRef.current = Date.now();
        map.easeTo({
          center: [lastVehicleLatLngRef.current.lng, lastVehicleLatLngRef.current.lat],
          zoom: DEFAULT_FOLLOW_ZOOM,
          duration: 700,
        });
      };

      // ---- create the marker on the first update ----
      if (!vehicleMarkerRef.current) {
        const el = document.createElement('div');
        el.style.width = '44px';
        el.style.height = '44px';
        const img = document.createElement('img');
        img.src = imgUrl;
        img.style.width = '44px';
        img.style.height = '44px';
        img.style.objectFit = 'contain';
        img.style.display = 'block';
        img.style.willChange = 'transform';
        el.appendChild(img);
        vehicleImgRef.current = img;
        vehicleMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
        if (showVehicle === false) vehicleMarkerRef.current.getElement().style.display = 'none';
        rotTargetRef.current = Number.isFinite(vehiclePosition.heading) ? vehiclePosition.heading : 0;
        stepRotation(1e6);
        lastGpsPosRef.current = { lat, lng };
        lastGpsAtRef.current = performance.now();
        centerOnce();
        // fall through so a route that is already drawn also snaps the vehicle onto it
      } else if (vehicleImgRef.current && vehicleImgRef.current.src !== imgUrl) {
        vehicleImgRef.current.src = imgUrl;
      }

      const marker = vehicleMarkerRef.current!;
      centerOnce();

      const nowPerf = performance.now();
      const gap = lastGpsAtRef.current ? nowPerf - lastGpsAtRef.current : 1000;
      lastGpsAtRef.current = nowPerf;
      const dur = Math.max(700, Math.min(2500, gap * 1.05 || 1000));

      if (vehicleAnimRef.current) cancelAnimationFrame(vehicleAnimRef.current);
      vehicleAnimRef.current = null;

      const route = routeRef.current;
      const prevGps = lastGpsPosRef.current;
      lastGpsPosRef.current = { lat, lng };

      // ---- is the vehicle on the route, or has it left it? ----
      let onRoute = false;
      let s1 = sAnimRef.current;
      if (route) {
        const pr = projectOnRoute(route, lng, lat, sAnimRef.current);
        const wentBack = sAnimRef.current - pr.s > 60;
        if (pr.off <= SNAP_M && !wentBack) {
          onRoute = true;
          s1 = Math.max(pr.s, sAnimRef.current); // never move backwards because of GPS noise
        }
        const isOff = pr.off > OFF_ROUTE_M || wentBack;
        const st = offRouteRef.current;
        if (isOff) {
          if (!st.since) st.since = Date.now();
          st.count += 1;
          if (st.count >= 3 && Date.now() - st.since >= 6000 && Date.now() - st.lastAskAt >= 15000) {
            st.lastAskAt = Date.now();
            onOffRouteRef.current?.(lat, lng);
          }
        } else if (pr.off <= SNAP_M) {
          st.count = 0;
          st.since = 0;
        }
      }

      const updateLine = (s: number, force: boolean, ts: number) => {
        const r = routeRef.current;
        if (!r) return;
        if (!force && ts - lastLineAtRef.current < 90) return;
        lastLineAtRef.current = ts;
        const src = map.getSource('route-source') as maplibregl.GeoJSONSource | undefined;
        if (!src) return;
        const coords = sliceFrom(r, s);
        currentCoordsRef.current = coords;
        src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
      };

      if (onRoute && route) {
        const s0 = sAnimRef.current;
        headingAnchorRef.current = { lat, lng };
        const here = marker.getLngLat();
        const aim = pointAt(route, s1);
        if (metersBetween(here.lat, here.lng, aim[1], aim[0]) > JUMP_M) {
          sAnimRef.current = s1;
          marker.setLngLat(aim);
          const bj = bearingAt(route, s1);
          if (Number.isFinite(bj)) { rotTargetRef.current = bj; stepRotation(1e6); }
          updateLine(s1, true, nowPerf);
          return;
        }
        if (s1 - s0 < 0.5) {
          // standing still: just make sure the picture faces the road
          const b = bearingAt(route, s1);
          if (Number.isFinite(b)) { rotTargetRef.current = b; stepRotation(1e6); }
          marker.setLngLat(pointAt(route, s1));
          updateLine(s1, true, nowPerf);
          return;
        }
        let t0: number | null = null;
        lastFrameAtRef.current = 0;
        const frame = (ts: number) => {
          if (routeRef.current !== route) return; // a new route arrived; the next GPS update takes over
          if (t0 === null) t0 = ts;
          const t = Math.min(1, (ts - t0) / dur);
          const s = s0 + (s1 - s0) * t; // even speed, like a real vehicle
          sAnimRef.current = s;
          marker.setLngLat(pointAt(route, s));
          const b = bearingAt(route, s);
          if (Number.isFinite(b)) rotTargetRef.current = b;
          const dt = lastFrameAtRef.current ? ts - lastFrameAtRef.current : 16;
          lastFrameAtRef.current = ts;
          stepRotation(TURN_DEG_PER_MS * Math.min(dt, 50));
          updateLine(s, t >= 1, ts);
          if (t < 1) vehicleAnimRef.current = requestAnimationFrame(frame);
          else vehicleAnimRef.current = null;
        };
        vehicleAnimRef.current = requestAnimationFrame(frame);
        return;
      }

      // ---- not on a route: straight to the GPS point, facing the direction of travel ----
      const start = marker.getLngLat();
      const moved = metersBetween(start.lat, start.lng, lat, lng);
      // Face the direction of travel. Measured from the last point we turned at (not from the previous fix),
      // so slow driving and turns still change the heading instead of waiting for a 6 m jump.
      const anchor = headingAnchorRef.current || prevGps;
      if (anchor && metersBetween(anchor.lat, anchor.lng, lat, lng) > 4) {
        rotTargetRef.current = bearingBetween(anchor.lat, anchor.lng, lat, lng);
        headingAnchorRef.current = { lat, lng };
      } else if (!anchor) {
        headingAnchorRef.current = { lat, lng };
      }
      if (moved > JUMP_M) {
        marker.setLngLat([lng, lat]);
        stepRotation(1e6);
        return;
      }
      let t0: number | null = null;
      lastFrameAtRef.current = 0;
      const frame = (ts: number) => {
        if (t0 === null) t0 = ts;
        const t = Math.min(1, (ts - t0) / dur);
        marker.setLngLat([start.lng + (lng - start.lng) * t, start.lat + (lat - start.lat) * t]);
        const dt = lastFrameAtRef.current ? ts - lastFrameAtRef.current : 16;
        lastFrameAtRef.current = ts;
        stepRotation(TURN_DEG_PER_MS * Math.min(dt, 50));
        if (t < 1) vehicleAnimRef.current = requestAnimationFrame(frame);
        else vehicleAnimRef.current = null;
      };
      vehicleAnimRef.current = requestAnimationFrame(frame);
    };

    if (isReadyRef.current) {
      run();
    } else {
      map.once('load', run);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehiclePosition, vehicleType, vehicleColor, vehicleIcon]);

  // ---- Demand zones: shaded areas + "Name 7%" labels (red = busiest, yellow = medium, green = quiet) ----
  const zoneLabelsRef = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      zoneLabelsRef.current.forEach((m) => m.remove());
      zoneLabelsRef.current = [];
      const list = zones || [];
      const data: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: list.map((z) => ({
          type: 'Feature',
          properties: { color: z.color },
          geometry: { type: 'Polygon', coordinates: [circlePolygon(z.lat, z.lng, z.radiusM)] },
        })),
      };
      const src = map.getSource('zones-source') as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
      } else if (list.length) {
        map.addSource('zones-source', { type: 'geojson', data });
        const before = map.getLayer('route-layer') ? 'route-layer' : undefined;
        map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones-source', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.28 } }, before);
        map.addLayer({ id: 'zones-line', type: 'line', source: 'zones-source', paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.7 } }, before);
      }
      list.forEach((z) => {
        const el = document.createElement('div');
        el.style.cssText = 'pointer-events:none;text-align:center;font-family:sans-serif;line-height:1.15;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;';
        el.innerHTML = `<div style="font-size:12px;font-weight:700;color:#222">${z.name.replace(/</g, '&lt;')}</div><div style="font-size:13px;font-weight:800;color:${z.color}">${z.percent}%</div>`;
        zoneLabelsRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([z.lng, z.lat]).addTo(map));
      });
    };
    if (isReadyRef.current) apply(); else map.once('load', apply);

    // First time busy areas appear: zoom OUT so the whole mapped area (and the driver) is visible.
    const list = zones || [];
    zonesActiveRef.current = list.length > 0;
    if (list.length === 0) {
      zonesFittedRef.current = false;
    } else if (!zonesFittedRef.current) {
      zonesFittedRef.current = true;
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      const grow = (lat: number, lng: number, rM = 0) => {
        const dLat = rM / 111320;
        const dLng = rM / (111320 * Math.cos((lat * Math.PI) / 180));
        minLat = Math.min(minLat, lat - dLat); maxLat = Math.max(maxLat, lat + dLat);
        minLng = Math.min(minLng, lng - dLng); maxLng = Math.max(maxLng, lng + dLng);
      };
      list.forEach((z) => grow(z.lat, z.lng, z.radiusM));
      if (lastVehicleLatLngRef.current) grow(lastVehicleLatLngRef.current.lat, lastVehicleLatLngRef.current.lng, 300);
      const doFit = () => {
        lastUserInteractionRef.current = Date.now();
        map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: { top: 120, bottom: 320, left: 60, right: 70 }, duration: 900, maxZoom: 14 });
      };
      if (isReadyRef.current) doFit(); else map.once('load', doFit);
    }
    return () => { /* labels are replaced on the next run */ };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones]);

  // ---- Diff + render markers ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      const next = markers || [];
      const nextIds = new Set(next.map((m) => m.id));

      // Remove stale markers
      Object.keys(markersRef.current).forEach((id) => {
        if (!nextIds.has(id)) {
          markersRef.current[id].remove();
          delete markersRef.current[id];
        }
      });

      // Add new markers
      next.forEach((m) => {
        if (markersRef.current[m.id]) return; // already present

        const el = document.createElement('div');
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';

        const inner = document.createElement('div');
        inner.style.border = '3px solid #fff';
        inner.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';

        if (m.type === 'dropoff') {
          inner.style.width = '26px';
          inner.style.height = '26px';
          inner.style.background = '#5B2EFF';
          inner.style.borderRadius = '50% 50% 50% 0';
          inner.style.transform = 'rotate(-45deg)';
        } else if (m.type === 'store') {
          inner.style.width = '22px';
          inner.style.height = '22px';
          inner.style.background = '#F59E0B';
          inner.style.borderRadius = '50%';
        } else if (m.type === 'stop') {
          inner.style.width = '24px';
          inner.style.height = '24px';
          inner.style.background = '#5B2EFF';
          inner.style.borderRadius = '50%';
          inner.style.color = '#fff';
          inner.style.fontSize = '12px';
          inner.style.fontWeight = '700';
          inner.style.fontFamily = '-apple-system, system-ui, sans-serif';
          inner.style.display = 'flex';
          inner.style.alignItems = 'center';
          inner.style.justifyContent = 'center';
          inner.textContent = (m.id || '').toString().replace('stop-', '') || '';
        } else {
          // pickup (default)
          inner.style.width = '22px';
          inner.style.height = '22px';
          inner.style.background = '#5B2EFF';
          inner.style.borderRadius = '50%';
        }

        el.appendChild(inner);
        markersRef.current[m.id] = new maplibregl.Marker({ element: el })
          .setLngLat([m.lng, m.lat])
          .addTo(map);
      });
    };

    if (isReadyRef.current) {
      apply();
    } else {
      map.once('load', apply);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers]);

  // ---- Arrival card: create / update / remove ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      // Remove existing card first
      if (arrivalCardRef.current) {
        arrivalCardRef.current.remove();
        arrivalCardRef.current = null;
      }
      if (!arrivalTime || !arrivalPosition) return;

      const el = createArrivalCard(arrivalTime);
      arrivalCardRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([arrivalPosition.lng, arrivalPosition.lat])
        .addTo(map);
    };

    if (isReadyRef.current) {
      apply();
    } else {
      map.once('load', apply);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivalTime, arrivalPosition?.lat, arrivalPosition?.lng]);

  const btn: React.CSSProperties = {
    width: 44, height: 44, borderRadius: 12, border: 'none', background: '#ffffff', color: '#18201b',
    fontSize: 26, fontWeight: 600, lineHeight: '44px', padding: 0, cursor: 'pointer',
    boxShadow: '0 2px 6px rgba(0,0,0,0.25)', display: 'block',
  };
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {/* zoom in / out, right side like Uber and Yango */}
      <div style={{ position: 'absolute', right: 12, top: '38%', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 5 }}>
        <button type="button" aria-label="Zoom in" style={btn} onClick={() => { lastUserInteractionRef.current = Date.now(); mapRef.current?.zoomIn({ duration: 250 }); }}>+</button>
        <button type="button" aria-label="Zoom out" style={btn} onClick={() => { lastUserInteractionRef.current = Date.now(); mapRef.current?.zoomOut({ duration: 250 }); }}>−</button>
      </div>
    </div>
  );
}

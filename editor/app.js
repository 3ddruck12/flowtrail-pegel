(function () {
  "use strict";

  var REPO = "3ddruck12/flowtrail-pegel";
  var POIS_REPO = "3ddruck12/flowtrail-pois";
  var BRANCH = "main";
  var COMMUNITY_PATH = "community-waterways.geojson";
  var POIS_COMMUNITY_PATH = "community-pois.geojson";
  var GUIDES_PATH = "river-guides.json";
  var TOKEN_KEY = "flowtrail_github_token";
  var RAW_BASE = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/";
  var API_BASE = "https://api.github.com/repos/" + REPO;
  var POIS_API_BASE = "https://api.github.com/repos/" + POIS_REPO;
  var editorMode = "waterways";
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  var VIEWPORT_OSM_LIMIT = 300;
  var OSM_LIVE_MIN_ZOOM = 10;
  var osmLiveAbort = null;
  var osmLiveBoundsKey = "";

  var BASEMAP_STORAGE_KEY = "flowtrail_editor_basemap";
  var currentBasemapLayer = null;
  var TILE_LAYERS = {
    carto: {
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      attribution: "© OSM © CARTO",
      options: { maxZoom: 20, subdomains: "abcd" }
    },
    carto_light: {
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      attribution: "© OSM © CARTO",
      options: { maxZoom: 20, subdomains: "abcd" }
    },
    carto_dark: {
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      attribution: "© OSM © CARTO",
      options: { maxZoom: 20, subdomains: "abcd" }
    },
    osm: {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: "© OpenStreetMap",
      options: { maxZoom: 19, subdomains: "abc" }
    },
    topo: {
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      attribution: "© OpenTopoMap © OSM",
      options: { maxZoom: 17, subdomains: "abc" }
    },
    humanitarian: {
      url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
      attribution: "© OSM © HOT",
      options: { maxZoom: 19, subdomains: "abc" }
    }
  };

  function switchBasemap(layerId) {
    var cfg = TILE_LAYERS[layerId] || TILE_LAYERS.carto;
    if (currentBasemapLayer) map.removeLayer(currentBasemapLayer);
    currentBasemapLayer = L.tileLayer(cfg.url, Object.assign({ attribution: cfg.attribution }, cfg.options));
    currentBasemapLayer.addTo(map);
    try {
      sessionStorage.setItem(BASEMAP_STORAGE_KEY, layerId);
    } catch (e) { /* ignore */ }
    var sel = document.getElementById("basemapSelect");
    if (sel && sel.value !== layerId) sel.value = layerId;
  }

  var map = L.map("map", { zoomControl: false }).setView([51.45, 7.45], 9);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  var initialBasemap = "carto";
  try {
    initialBasemap = sessionStorage.getItem(BASEMAP_STORAGE_KEY) || "carto";
  } catch (e) { /* ignore */ }
  if (!TILE_LAYERS[initialBasemap]) initialBasemap = "carto";
  switchBasemap(initialBasemap);
  document.getElementById("basemapSelect").onchange = function () {
    switchBasemap(this.value);
  };

  map.pm.setLang("de");
  map.pm.addControls({
    position: "topleft",
    drawMarker: false,
    drawCircleMarker: false,
    drawPolyline: false,
    drawRectangle: false,
    drawPolygon: false,
    drawCircle: false,
    drawText: false,
    cutPolygon: false,
    rotateMode: false,
    removalMode: false
  });

  var communityLayer = L.layerGroup().addTo(map);
  var trimPreviewLayer = L.layerGroup().addTo(map);
  var trimMarkerLayer = L.layerGroup().addTo(map);
  var osmFileLayer = L.layerGroup().addTo(map);
  var osmLiveLayer = L.layerGroup().addTo(map);

  var communityFeatures = [];
  var riverGuides = { version: "", label: "", rivers: [] };
  var osmFileFeatures = [];
  var osmLiveFeatures = [];
  var osmFileLoaded = false;
  var trimMode = false;
  var trimPoints = [];
  var trimSnapPoints = [];
  var trimTargetIndex = -1;
  var selectedIndex = -1;
  var upstreamPickMode = false;
  var activeDrawMode = null;
  var lastPortageId = null;

  var statusBar = document.getElementById("statusBar");
  var sidebar = document.getElementById("sidebar");
  var guideSidebar = document.getElementById("guideSidebar");
  var featureForm = document.getElementById("featureForm");

  function setStatus(msg) {
    statusBar.textContent = msg;
  }

  function slugify(text) {
    return String(text || "segment")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "segment";
  }

  function newFeatureId(prefix) {
    return slugify(prefix) + "-" + Date.now().toString(36);
  }

  function featureKind(feature) {
    var p = feature.properties || {};
    if (p.feature_kind) return p.feature_kind;
    if (feature.geometry.type === "Point") return p.type === "Ausstieg" ? "ausstieg" : "einstieg";
    return "waterway";
  }

  function coordsToLatLngs(coords) {
    return coords.map(function (c) {
      return L.latLng(c[1], c[0]);
    });
  }

  function latLngsToCoords(latlngs) {
    return latlngs.map(function (ll) {
      return [ll.lng, ll.lat];
    });
  }

  function featureToLayer(feature, style) {
    var geom = feature.geometry;
    if (geom.type === "LineString") {
      return L.polyline(coordsToLatLngs(geom.coordinates), style);
    }
    if (geom.type === "MultiLineString") {
      return L.polyline(
        geom.coordinates.map(function (line) {
          return coordsToLatLngs(line);
        }),
        style
      );
    }
    return null;
  }

  function layerToLineFeature(layer, props) {
    var latlngs = layer.getLatLngs();
    var coords;
    if (Array.isArray(latlngs[0]) && latlngs[0].lat === undefined) {
      coords = latlngs.map(function (part) {
        return latLngsToCoords(part);
      });
      return {
        type: "Feature",
        geometry: { type: "MultiLineString", coordinates: coords },
        properties: props
      };
    }
    coords = latLngsToCoords(latlngs);
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: props
    };
  }

  function layerToPointFeature(layer, props) {
    var ll = layer.getLatLng();
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [ll.lng, ll.lat] },
      properties: props
    };
  }

  function defaultsForDrawMode(mode) {
    var base = { source: "community", river: "" };
    if (mode === "portage" || mode === "portage_road") {
      var id = newFeatureId("umtrag");
      lastPortageId = id;
      return Object.assign(base, {
        id: id,
        feature_kind: mode,
        name: mode === "portage_road" ? "Umtrag Weg" : "Umtrag",
        portage_id: id
      });
    }
    if (mode === "einstieg" || mode === "ausstieg") {
      return Object.assign(base, {
        id: newFeatureId(mode),
        feature_kind: mode,
        name: mode === "einstieg" ? "Einstieg (Umtrag)" : "Ausstieg (Umtrag)",
        portage_id: lastPortageId || "",
        type: mode === "einstieg" ? "Einstieg" : "Ausstieg"
      });
    }
    return Object.assign(base, {
      id: newFeatureId("fluss"),
      feature_kind: "waterway",
      name: "Neues Gewässer",
      waterway: "river",
      replaces_osm_ids: [],
      navigable: true,
      flow_direction: "with_coords"
    });
  }

  function buildCommunityCollection() {
    return {
      type: "FeatureCollection",
      metadata: {
        name: "FlowTrail Community Map",
        description: "Flussläufe, Umträge, Ein-/Ausstiege (Community).",
        version: new Date().toISOString().slice(0, 16).replace("T", "T")
      },
      features: communityFeatures
    };
  }

  function isNavigable(props) {
    if (!props) return true;
    if (props.navigable === false) return false;
    var r = (props.restriction || "").toLowerCase();
    return r !== "no_canoe" && r !== "no_paddle" && r !== "closed" && r !== "gesperrt";
  }

  function lineStyle(props, isSelected) {
    var kind = props.feature_kind || "waterway";
    var style;
    if (kind === "portage" || kind === "portage_road") {
      style = {
        color: "#eab308",
        weight: kind === "portage_road" ? 4 : 5,
        opacity: 0.95,
        dashArray: "10 8",
        className: "community-portage"
      };
    } else {
      var ok = isNavigable(props);
      style = {
        color: ok ? "#0284c7" : "#dc2626",
        weight: ok ? 4 : 5,
        opacity: 0.9,
        dashArray: ok ? null : "10 8",
        className: "community-waterway"
      };
    }
    if (isSelected) {
      style.color = "#fbbf24";
      style.weight = (style.weight || 4) + 5;
      style.opacity = 1;
      style.className = (style.className || "") + " community-layer-selected";
    }
    return style;
  }

  function pointIcon(kind) {
    var isIn = kind === "einstieg";
    return L.divIcon({
      className: "",
      html:
        '<div class="poi-pin ' + (isIn ? "pin-einstieg" : "pin-ausstieg") + '">' +
        (isIn ? "E" : "A") +
        "</div>",
      iconSize: [24, 24],
      iconAnchor: [12, 24]
    });
  }

  function linePoints(feature) {
    var g = feature.geometry;
    if (g.type === "LineString") return coordsToLatLngs(g.coordinates);
    if (g.type === "MultiLineString" && g.coordinates[0]) return coordsToLatLngs(g.coordinates[0]);
    return [];
  }

  function orderedLineLatLngs(feature) {
    var pts = linePoints(feature);
    if (pts.length < 2) return pts;
    var props = feature.properties || {};
    var up = props.upstream_node;
    if (!up || up.length < 2) {
      return props.flow_direction === "reverse_coords" ? pts.slice().reverse() : pts;
    }
    var upLl = L.latLng(up[1], up[0]);
    var reverseByUp = upLl.distanceTo(pts[0]) > upLl.distanceTo(pts[pts.length - 1]);
    var reverseByFlow = props.flow_direction === "reverse_coords";
    if (reverseByUp !== reverseByFlow) return pts.slice().reverse();
    return pts;
  }

  function arrowLatLng(feature) {
    var pts = orderedLineLatLngs(feature);
    if (pts.length < 2) return null;
    var idx = Math.min(pts.length - 1, Math.max(1, Math.floor(pts.length * 0.72)));
    return pts[idx];
  }

  function arrowBearing(from, to) {
    var y = Math.sin((to.lng - from.lng) * Math.PI / 180) * Math.cos(to.lat * Math.PI / 180);
    var x =
      Math.cos(from.lat * Math.PI / 180) * Math.sin(to.lat * Math.PI / 180) -
      Math.sin(from.lat * Math.PI / 180) * Math.cos(to.lat * Math.PI / 180) *
      Math.cos((to.lng - from.lng) * Math.PI / 180);
    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  function addDirectionDecorations(feature, layerGroup) {
    if (featureKind(feature) !== "waterway") return;
    var props = feature.properties || {};
    var ordered = orderedLineLatLngs(feature);
    if (ordered.length < 2) return;
    if (props.upstream_node && props.upstream_node.length >= 2) {
      L.marker([props.upstream_node[1], props.upstream_node[0]], {
        icon: L.divIcon({
          className: "",
          html: '<div class="upstream-pin"></div>',
          iconSize: [12, 12],
          iconAnchor: [6, 6]
        }),
        interactive: false
      }).addTo(layerGroup);
    }
    var arrow = arrowLatLng(feature);
    if (!arrow) return;
    var idx = Math.min(ordered.length - 1, Math.max(1, Math.floor(ordered.length * 0.72)));
    var prev = ordered[idx - 1];
    var deg = arrowBearing(prev, arrow);
    L.marker(arrow, {
      icon: L.divIcon({
        className: "",
        html: '<div class="waterway-arrow-marker" style="transform:rotate(' + deg + 'deg)">▶</div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      }),
      interactive: false
    }).addTo(layerGroup);
  }

  function featureBounds(feature) {
    if (feature.geometry.type === "Point") {
      var c = feature.geometry.coordinates;
      var ll = L.latLng(c[1], c[0]);
      return L.latLngBounds(ll, ll);
    }
    var layer = featureToLayer(feature, {});
    return layer ? layer.getBounds() : null;
  }

  function fitCommunityBounds() {
    var bounds = null;
    communityFeatures.forEach(function (f) {
      var b = featureBounds(f);
      if (!b) return;
      bounds = bounds ? bounds.extend(b) : b;
    });
    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.12));
    }
  }

  function osmStyle() {
    return { color: "#64748b", weight: 3, opacity: 0.75, dashArray: "6 4" };
  }

  function osmLiveStyle() {
    return { color: "#94a3b8", weight: 2, opacity: 0.6, dashArray: "3 6" };
  }

  function isBlockedOsm(props) {
    var osmId = (props && props.osm_id) || "";
    if (!osmId) return false;
    return communityFeatures.some(function (f) {
      var replaces = f.properties.replaces_osm_ids || [];
      if (typeof replaces === "string") replaces = replaces ? [replaces] : [];
      return replaces.indexOf(osmId) >= 0;
    });
  }

  function featureIntersectsMapBounds(feature, bounds) {
    var g = feature.geometry;
    if (!g || !g.coordinates) return false;
    if (g.type === "Point") {
      var c = g.coordinates;
      return bounds.contains(L.latLng(c[1], c[0]));
    }
    var lines = g.type === "LineString" ? [g.coordinates] : g.coordinates;
    var south = bounds.getSouth();
    var north = bounds.getNorth();
    var west = bounds.getWest();
    var east = bounds.getEast();
    for (var li = 0; li < lines.length; li++) {
      var coords = lines[li];
      if (!coords || !coords.length) continue;
      var step = Math.max(1, Math.floor(coords.length / 8));
      for (var i = 0; i < coords.length; i += step) {
        var lat = coords[i][1];
        var lon = coords[i][0];
        if (lat >= south && lat <= north && lon >= west && lon <= east) return true;
      }
    }
    return false;
  }

  function featuresInViewport(features, limit) {
    if (!features.length || !map.getBounds().isValid()) return [];
    var bounds = map.getBounds();
    var zoom = map.getZoom();
    var cap = limit;
    if (zoom < 8) cap = Math.min(limit, 40);
    else if (zoom < 10) cap = Math.min(limit, 120);
    else if (zoom < 12) cap = Math.min(limit, 200);
    var filtered = [];
    for (var i = 0; i < features.length; i++) {
      if (featureIntersectsMapBounds(features[i], bounds)) {
        filtered.push(features[i]);
        if (filtered.length >= cap) break;
      }
    }
    return filtered;
  }

  function debounce(fn, waitMs) {
    var timer;
    return function () {
      var self = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(self, args);
      }, waitMs);
    };
  }

  function mapViewportKey() {
    var b = map.getBounds();
    return (
      map.getZoom() +
      "|" +
      b.getSouth().toFixed(4) +
      "|" +
      b.getWest().toFixed(4) +
      "|" +
      b.getNorth().toFixed(4) +
      "|" +
      b.getEast().toFixed(4)
    );
  }

  function updateDeleteButton() {
    document.getElementById("btnDeleteSelected").disabled = selectedIndex < 0;
  }

  function selectFeature(index, openSidebar) {
    selectedIndex = index;
    updateDeleteButton();
    redrawCommunity();
    if (openSidebar !== false && index >= 0) {
      openEditor(index);
    }
  }

  function deleteFeatureAt(index) {
    if (index < 0 || !communityFeatures[index]) return;
    var props = communityFeatures[index].properties || {};
    var label = props.name || props.river || featureKind(communityFeatures[index]);
    if (!confirm("„" + label + "“ wirklich löschen?")) return;
    communityFeatures.splice(index, 1);
    cancelTrim();
    closeSidebar();
    selectFeature(-1, false);
    setStatus("Objekt gelöscht.");
  }

  function clearTrimPreview() {
    trimPreviewLayer.clearLayers();
    trimMarkerLayer.clearLayers();
  }

  function cancelTrim() {
    trimMode = false;
    trimPoints = [];
    trimSnapPoints = [];
    trimTargetIndex = -1;
    document.getElementById("btnTrim").classList.remove("active");
    document.getElementById("trimPanel").classList.add("hidden");
    document.getElementById("btnTrimApply").disabled = true;
    clearTrimPreview();
  }

  function snapToWaterway(index, latlng) {
    var feature = communityFeatures[index];
    if (!feature || feature.geometry.type !== "LineString") return null;
    if (featureKind(feature) !== "waterway") return null;
    var line = turf.lineString(feature.geometry.coordinates);
    var snapped = turf.nearestPointOnLine(line, turf.point([latlng.lng, latlng.lat]), {
      units: "kilometers"
    });
    return {
      latlng: L.latLng(snapped.geometry.coordinates[1], snapped.geometry.coordinates[0]),
      distance: snapped.properties.location
    };
  }

  function drawPreviewLine(coords, style) {
    if (!coords || coords.length < 2) return;
    L.polyline(coordsToLatLngs(coords), style).addTo(trimPreviewLayer);
  }

  function updateTrimPreview() {
    clearTrimPreview();
    if (trimTargetIndex < 0 || trimSnapPoints.length < 2) {
      document.getElementById("btnTrimApply").disabled = true;
      return;
    }
    var feature = communityFeatures[trimTargetIndex];
    if (!feature) return;
    var line = turf.lineString(feature.geometry.coordinates);
    var dMin = Math.min(trimSnapPoints[0].distance, trimSnapPoints[1].distance);
    var dMax = Math.max(trimSnapPoints[0].distance, trimSnapPoints[1].distance);
    var op = document.querySelector('input[name="trimOp"]:checked').value;
    var startPt = turf.along(line, dMin, { units: "kilometers" });
    var endPt = turf.along(line, dMax, { units: "kilometers" });
    var middle = turf.lineSlice(startPt, endPt, line).geometry.coordinates;
    var partA = turf.lineSlice(
      turf.point(line.geometry.coordinates[0]),
      startPt,
      line
    ).geometry.coordinates;
    var partB = turf.lineSlice(
      endPt,
      turf.point(line.geometry.coordinates[line.geometry.coordinates.length - 1]),
      line
    ).geometry.coordinates;

    trimSnapPoints.forEach(function (sp, i) {
      L.marker(sp.latlng, {
        icon: L.divIcon({
          className: "",
          html:
            '<div class="trim-marker ' + (i === 0 ? "trim-marker-a" : "trim-marker-b") + '"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        }),
        interactive: false
      }).addTo(trimMarkerLayer);
    });

    if (op === "keep") {
      drawPreviewLine(partA, { color: "#ef4444", weight: 5, dashArray: "8 6", opacity: 0.85 });
      drawPreviewLine(partB, { color: "#ef4444", weight: 5, dashArray: "8 6", opacity: 0.85 });
      drawPreviewLine(middle, { color: "#22c55e", weight: 7, opacity: 0.95 });
      document.getElementById("btnTrimApply").disabled = middle.length < 2;
    } else {
      drawPreviewLine(middle, { color: "#ef4444", weight: 6, dashArray: "8 6", opacity: 0.9 });
      drawPreviewLine(partA, { color: "#22c55e", weight: 6, opacity: 0.95 });
      drawPreviewLine(partB, { color: "#22c55e", weight: 6, opacity: 0.95 });
      document.getElementById("btnTrimApply").disabled = partA.length < 2 && partB.length < 2;
    }
  }

  function applyTrim() {
    if (trimTargetIndex < 0 || trimSnapPoints.length < 2) return;
    var feature = communityFeatures[trimTargetIndex];
    var line = turf.lineString(feature.geometry.coordinates);
    var dMin = Math.min(trimSnapPoints[0].distance, trimSnapPoints[1].distance);
    var dMax = Math.max(trimSnapPoints[0].distance, trimSnapPoints[1].distance);
    var op = document.querySelector('input[name="trimOp"]:checked').value;
    try {
      var startPt = turf.along(line, dMin, { units: "kilometers" });
      var endPt = turf.along(line, dMax, { units: "kilometers" });
      if (op === "keep") {
        var kept = turf.lineSlice(startPt, endPt, line);
        if (kept.geometry.coordinates.length < 2) {
          throw new Error("Auswahl zu kurz — Punkte weiter auseinander wählen.");
        }
        feature.geometry.coordinates = kept.geometry.coordinates;
      } else {
        var partA = turf.lineSlice(turf.point(line.geometry.coordinates[0]), startPt, line);
        var partB = turf.lineSlice(
          endPt,
          turf.point(line.geometry.coordinates[line.geometry.coordinates.length - 1]),
          line
        );
        var coordsA = partA.geometry.coordinates;
        var coordsB = partB.geometry.coordinates;
        if (coordsA.length < 2 && coordsB.length < 2) {
          throw new Error("Es würde nichts übrig bleiben.");
        }
        if (coordsA.length >= 2) {
          feature.geometry.coordinates = coordsA;
          if (coordsB.length >= 2) {
            var tail = JSON.parse(JSON.stringify(feature));
            tail.properties = JSON.parse(JSON.stringify(feature.properties));
            tail.properties.id = newFeatureId(feature.properties.river || "teil");
            tail.geometry.coordinates = coordsB;
            communityFeatures.push(tail);
          }
        } else {
          feature.geometry.coordinates = coordsB;
        }
      }
      var idx = trimTargetIndex;
      cancelTrim();
      selectFeature(idx, true);
      setStatus("Stutzen angewendet — grüner Bereich ist das Ergebnis.");
    } catch (err) {
      setStatus("Stutzen: " + err.message);
    }
  }

  function handleTrimClick(index, latlng) {
    if (index < 0 || featureKind(communityFeatures[index]) !== "waterway") return;
    var snap = snapToWaterway(index, latlng);
    if (!snap) return;
    if (trimSnapPoints.length >= 2) {
      trimSnapPoints = [snap];
      trimPoints = [snap.latlng];
      document.getElementById("trimHint").textContent =
        "Neuer Punkt 1 — jetzt Punkt 2 auf derselben Linie.";
    } else {
      trimSnapPoints.push(snap);
      trimPoints.push(snap.latlng);
    }
    if (trimSnapPoints.length < 2) {
      document.getElementById("trimHint").textContent =
        "Punkt 1 gesetzt — Punkt 2 auf derselben Flusslinie wählen.";
      clearTrimPreview();
      L.marker(snap.latlng, {
        icon: L.divIcon({
          className: "",
          html: '<div class="trim-marker trim-marker-a"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        }),
        interactive: false
      }).addTo(trimMarkerLayer);
      return;
    }
    document.getElementById("trimHint").textContent =
      "Vorschau: Grün = bleibt, Rot = wird entfernt. Dann „Anwenden“.";
    updateTrimPreview();
  }

  function redrawCommunity() {
    communityLayer.clearLayers();
    communityFeatures.forEach(function (feature, index) {
      var kind = featureKind(feature);
      var props = feature.properties || {};
      var isSelected = index === selectedIndex;
      var clickFn = function (e) {
        if (trimMode) {
          if (feature.geometry.type !== "LineString" || kind !== "waterway") {
            setStatus("Stutzen: zuerst eine blaue Flusslinie wählen.");
            L.DomEvent.stopPropagation(e);
            return;
          }
          if (trimTargetIndex < 0) {
            trimTargetIndex = index;
            selectFeature(index, false);
            document.getElementById("trimHint").textContent =
              "„" + (props.name || props.river || "Fluss") +
              "“ gewählt — Punkt 1 auf der Linie klicken.";
            L.DomEvent.stopPropagation(e);
            return;
          }
          if (trimTargetIndex !== index) {
            setStatus("Stutzen nur auf der gewählten Linie — „Abbrechen“ für andere Linie.");
            L.DomEvent.stopPropagation(e);
            return;
          }
          handleTrimClick(index, e.latlng);
          L.DomEvent.stopPropagation(e);
          return;
        }
        L.DomEvent.stopPropagation(e);
        selectFeature(index, true);
      };

      if (feature.geometry.type === "Point") {
        var m = L.marker([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], {
          icon: pointIcon(kind),
          draggable: true
        })
          .on("click", clickFn)
          .on("dragend", function (e) {
            var ll = e.target.getLatLng();
            feature.geometry.coordinates = [ll.lng, ll.lat];
          })
          .addTo(communityLayer);
        if (isSelected) {
          m.setZIndexOffset(1000);
        }
        return;
      }

      var pts = linePoints(feature);
      if (pts.length >= 2) {
        L.polyline(pts, { color: "#000", weight: 18, opacity: 0, interactive: true })
          .on("click", clickFn)
          .addTo(communityLayer);
      }
      var layer = featureToLayer(feature, lineStyle(props, isSelected));
      if (!layer) return;
      layer.on("click", clickFn);
      if (isSelected && layer.bringToFront) {
        layer.bringToFront();
      }
      layer.addTo(communityLayer);
      addDirectionDecorations(feature, communityLayer);
    });
    updateStatusCounts();
  }

  function bindOsmPopup(layer, feature, adoptFn) {
    var props = feature.properties || {};
    layer.bindPopup(
      "<strong>" + (props.name || "OSM") + "</strong><br>" +
        (props.river ? "Fluss: " + props.river + "<br>" : "") +
        '<button type="button" class="btn primary adopt-btn" style="margin-top:8px">Als Fluss übernehmen</button>'
    );
    layer.on("popupopen", function () {
      var btn = document.querySelector(".adopt-btn");
      if (btn) btn.onclick = function () { adoptFn(feature); map.closePopup(); };
    });
  }

  function redrawOsmFile() {
    osmFileLayer.clearLayers();
    if (!document.getElementById("osmFileToggle").checked) return;
    if (map.getZoom() < 8) {
      setStatus("OSM-Import: weiter heranzoomen (Zoom ≥ 8) für Flusslinien.");
      return;
    }
    featuresInViewport(osmFileFeatures, VIEWPORT_OSM_LIMIT).forEach(function (feature) {
      if (isBlockedOsm(feature.properties)) return;
      var layer = featureToLayer(feature, osmStyle());
      if (layer) {
        bindOsmPopup(layer, feature, adoptOsmFeature);
        layer.addTo(osmFileLayer);
      }
    });
    updateStatusCounts();
  }

  function redrawOsmLive() {
    osmLiveLayer.clearLayers();
    if (!document.getElementById("osmLiveToggle").checked) return;
    featuresInViewport(osmLiveFeatures, VIEWPORT_OSM_LIMIT).forEach(function (feature) {
      if (isBlockedOsm(feature.properties)) return;
      var layer = featureToLayer(feature, osmLiveStyle());
      if (layer) {
        bindOsmPopup(layer, feature, adoptOsmFeature);
        layer.addTo(osmLiveLayer);
      }
    });
    updateStatusCounts();
  }

  function updateStatusCounts() {
    var kinds = { waterway: 0, portage: 0, portage_road: 0, einstieg: 0, ausstieg: 0 };
    communityFeatures.forEach(function (f) {
      var k = featureKind(f);
      kinds[k] = (kinds[k] || 0) + 1;
    });
    var poiSuffix = window.FlowTrailPoi ? FlowTrailPoi.getStatusSuffix() : "";
    setStatus(
      "Gewässer: " + kinds.waterway + " Fluss · " + kinds.portage + " Umtrag · " +
        kinds.portage_road + " Weg · " + kinds.einstieg + " Umtrag-E · " + kinds.ausstieg + " Umtrag-A · " +
        riverGuides.rivers.length + " Flussführer" + poiSuffix
    );
  }

  function closeAllSidebars() {
    closeSidebar();
    guideSidebar.classList.add("hidden");
    if (window.FlowTrailPoi) FlowTrailPoi.closeSidebar();
  }

  function setEditorMode(mode) {
    editorMode = mode;
    document.querySelectorAll(".mode-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    document.getElementById("toolbarWaterways").classList.toggle("hidden", mode !== "waterways");
    document.getElementById("toolbarPois").classList.toggle("hidden", mode !== "pois");
    if (mode === "pois") {
      clearDrawMode();
      cancelTrim();
      upstreamPickMode = false;
    } else if (window.FlowTrailPoi) {
      FlowTrailPoi.onModeChange(mode);
    }
    closeAllSidebars();
    if (mode === "pois" && window.FlowTrailPoi) {
      setStatus("Lade POI-Daten …");
      FlowTrailPoi.ensureLoaded()
        .then(function () {
          FlowTrailPoi.onModeChange("pois");
          updateStatusCounts();
          setStatus(
            "POI-Modus (" + FlowTrailPoi.featureCount() + " gesamt, nur sichtbarer Ausschnitt)."
          );
        })
        .catch(function (err) {
          setStatus("POI laden: " + err.message);
        });
      return;
    }
    updateStatusCounts();
  }

  function clearDrawMode() {
    activeDrawMode = null;
    map.pm.disableDraw();
    document.querySelectorAll(".tool-btn").forEach(function (b) {
      b.classList.remove("active");
    });
  }

  function startDrawMode(mode) {
    if (editorMode !== "waterways") return;
    clearDrawMode();
    trimMode = false;
    upstreamPickMode = false;
    document.getElementById("btnTrim").classList.remove("active");
    activeDrawMode = mode;
    document.querySelector('.tool-btn[data-draw="' + mode + '"]').classList.add("active");

    if (mode === "einstieg" || mode === "ausstieg") {
      map.pm.enableDraw("Marker", { snappable: true });
      setStatus("Setze " + (mode === "einstieg" ? "Einstieg" : "Ausstieg") + " auf die Karte.");
      return;
    }
    map.pm.enableDraw("Line", {
      snappable: true,
      snapDistance: 20,
      allowSelfIntersection: false
    });
    var labels = {
      waterway: "Flusslinie",
      portage: "Umtrag (gelb, gestrichelt)",
      portage_road: "Weg/Straße (gelb)"
    };
    setStatus("Zeichne: " + (labels[mode] || mode));
  }

  function showFieldPanels(kind) {
    document.getElementById("waterwayFields").classList.toggle("hidden", kind !== "waterway");
    document.getElementById("portageFields").classList.toggle(
      "hidden",
      kind !== "portage" && kind !== "portage_road"
    );
    document.getElementById("pointFields").classList.toggle(
      "hidden",
      kind !== "einstieg" && kind !== "ausstieg"
    );
    document.getElementById("btnSetUpstream").parentElement.parentElement.classList.toggle(
      "hidden",
      kind !== "waterway"
    );
  }

  function openEditor(index) {
    var feature = communityFeatures[index];
    if (!feature) return;
    selectedIndex = index;
    updateDeleteButton();
    var kind = featureKind(feature);
    var props = feature.properties || {};
    guideSidebar.classList.add("hidden");
    if (window.FlowTrailPoi) FlowTrailPoi.closeSidebar();
    sidebar.classList.remove("hidden");
    document.getElementById("featureIndex").value = String(index);
    document.getElementById("featId").value = props.id || "";
    showFieldPanels(kind);

    if (kind === "waterway") {
      document.getElementById("sidebarTitle").textContent = "Fluss bearbeiten";
      document.getElementById("wwName").value = props.name || "";
      document.getElementById("wwRiver").value = props.river || "";
      document.getElementById("wwType").value = props.waterway || "river";
      document.getElementById("wwNavigable").checked = isNavigable(props);
      document.getElementById("wwFlow").value =
        props.flow_direction === "reverse_coords" ? "reverse_coords" : "with_coords";
      var up = props.upstream_node;
      document.getElementById("wwUpstreamLabel").textContent =
        up && up.length >= 2 ? up[1].toFixed(5) + ", " + up[0].toFixed(5) : "nicht gesetzt";
    } else if (kind === "portage" || kind === "portage_road") {
      document.getElementById("sidebarTitle").textContent =
        kind === "portage_road" ? "Umtrag-Weg bearbeiten" : "Umtrag bearbeiten";
      document.getElementById("pgName").value = props.name || "";
      document.getElementById("pgRiver").value = props.river || "";
      document.getElementById("pgPortageId").value = props.portage_id || props.id || "";
      lastPortageId = props.portage_id || props.id;
    } else {
      document.getElementById("sidebarTitle").textContent = kind === "einstieg" ? "Einstieg" : "Ausstieg";
      document.getElementById("ptKind").value = kind;
      document.getElementById("ptName").value = props.name || "";
      document.getElementById("ptRiver").value = props.river || "";
      document.getElementById("ptPortageId").value = props.portage_id || "";
    }

    var replaces = props.replaces_osm_ids || [];
    if (typeof replaces === "string") replaces = replaces ? [replaces] : [];
    document.getElementById("wwReplacesOsm").value = replaces.join(", ");
    document.getElementById("replacesRow").classList.toggle("hidden", !replaces.length);
    trimTargetIndex = index;
  }

  function closeSidebar() {
    sidebar.classList.add("hidden");
    document.getElementById("featureIndex").value = "-1";
    trimTargetIndex = -1;
    upstreamPickMode = false;
    document.getElementById("btnSetUpstream").classList.remove("active");
  }

  function adoptOsmFeature(osmFeature) {
    var props = osmFeature.properties || {};
    var copy = JSON.parse(JSON.stringify(osmFeature));
    copy.properties = {
      id: newFeatureId(props.river || props.name),
      feature_kind: "waterway",
      name: props.name || "Gewässer",
      river: props.river || "",
      waterway: props.waterway || "river",
      source: "community",
      replaces_osm_ids: props.osm_id ? [props.osm_id] : [],
      navigable: true,
      flow_direction: "with_coords"
    };
    communityFeatures.push(copy);
    redrawCommunity();
    redrawOsmFile();
    redrawOsmLive();
    openEditor(communityFeatures.length - 1);
  }

  function listRiversFromFeatures() {
    var names = {};
    communityFeatures.forEach(function (f) {
      var r = (f.properties && f.properties.river) || "";
      if (r.trim()) names[r.trim()] = true;
    });
    riverGuides.rivers.forEach(function (g) {
      if (g.river) names[g.river] = true;
    });
    return Object.keys(names).sort();
  }

  function findGuide(riverName) {
    return riverGuides.rivers.find(function (g) {
      return g.river === riverName;
    });
  }

  function refreshGuideRiverSelect() {
    var sel = document.getElementById("guideRiverSelect");
    var current = sel.value;
    sel.innerHTML = "";
    listRiversFromFeatures().forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
    loadGuideIntoForm();
  }

  function loadGuideIntoForm() {
    var river = document.getElementById("guideRiverSelect").value;
    var guide = findGuide(river);
    document.getElementById("guideDescription").value = guide ? guide.description || "" : "";
    var container = document.getElementById("guideSections");
    container.innerHTML = "";
    var sections = guide && guide.sections ? guide.sections : [];
    sections.forEach(function (sec, i) {
      container.appendChild(createSectionEditor(sec, i));
    });
  }

  function createSectionEditor(sec, index) {
    var div = document.createElement("div");
    div.className = "section-card";
    div.dataset.index = String(index);
    div.innerHTML =
      '<label>Abschnitt <input type="text" class="sec-name" value="' +
      escapeAttr(sec.name || "") +
      '" /></label>' +
      '<label>Regeln <textarea class="sec-rules" rows="3">' +
      escapeHtml(sec.rules || "") +
      "</textarea></label>" +
      '<label>Notizen <textarea class="sec-notes" rows="2">' +
      escapeHtml(sec.notes || "") +
      "</textarea></label>" +
      '<button type="button" class="btn danger btn-sec-del">Abschnitt löschen</button>';
    div.querySelector(".btn-sec-del").onclick = function () {
      div.remove();
    };
    return div;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function collectGuideFromForm() {
    var river = document.getElementById("guideRiverSelect").value;
    if (!river) return null;
    var sections = [];
    document.querySelectorAll("#guideSections .section-card").forEach(function (card, i) {
      sections.push({
        id: slugify(river) + "-sec-" + i,
        name: card.querySelector(".sec-name").value.trim() || "Abschnitt " + (i + 1),
        rules: card.querySelector(".sec-rules").value.trim(),
        notes: card.querySelector(".sec-notes").value.trim()
      });
    });
    return {
      river_id: slugify(river),
      river: river,
      description: document.getElementById("guideDescription").value.trim(),
      sections: sections
    };
  }

  function saveGuideLocal() {
    var g = collectGuideFromForm();
    if (!g) {
      setStatus("Flussname wählen.");
      return;
    }
    var idx = riverGuides.rivers.findIndex(function (x) { return x.river === g.river; });
    if (idx >= 0) riverGuides.rivers[idx] = g;
    else riverGuides.rivers.push(g);
    riverGuides.version = new Date().toISOString().slice(0, 16);
    setStatus("Flussführer lokal aktualisiert. „In Repo speichern“ für GitHub.");
    updateStatusCounts();
  }

  function openGuidePanel() {
    closeAllSidebars();
    guideSidebar.classList.remove("hidden");
    refreshGuideRiverSelect();
  }

  featureForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var index = parseInt(document.getElementById("featureIndex").value, 10);
    if (index < 0 || !communityFeatures[index]) return;
    var feature = communityFeatures[index];
    var props = feature.properties;
    var kind = featureKind(feature);
    props.id = document.getElementById("featId").value.trim() || props.id;
    props.source = "community";
    props.feature_kind = kind;

    if (kind === "waterway") {
      props.name = document.getElementById("wwName").value.trim();
      props.river = document.getElementById("wwRiver").value.trim();
      props.waterway = document.getElementById("wwType").value;
      props.navigable = document.getElementById("wwNavigable").checked;
      props.flow_direction = document.getElementById("wwFlow").value;
      if (!props.navigable) props.restriction = "no_canoe";
      else delete props.restriction;
    } else if (kind === "portage" || kind === "portage_road") {
      props.name = document.getElementById("pgName").value.trim();
      props.river = document.getElementById("pgRiver").value.trim();
      props.portage_id = document.getElementById("pgPortageId").value.trim() || props.id;
      lastPortageId = props.portage_id;
    } else {
      props.name = document.getElementById("ptName").value.trim();
      props.river = document.getElementById("ptRiver").value.trim();
      props.portage_id = document.getElementById("ptPortageId").value.trim();
      props.type = kind === "einstieg" ? "Einstieg" : "Ausstieg";
    }
    redrawCommunity();
    closeSidebar();
    setStatus("Gespeichert (lokal).");
  });

  document.getElementById("btnDelete").onclick = function () {
    var index = parseInt(document.getElementById("featureIndex").value, 10);
    deleteFeatureAt(index);
  };

  document.getElementById("btnDeleteSelected").onclick = function () {
    deleteFeatureAt(selectedIndex);
  };

  document.getElementById("btnClose").onclick = closeSidebar;
  document.getElementById("btnSetUpstream").onclick = function () {
    var index = parseInt(document.getElementById("featureIndex").value, 10);
    if (index < 0) return setStatus("Zuerst Fluss wählen.");
    upstreamPickMode = !upstreamPickMode;
    document.getElementById("btnSetUpstream").classList.toggle("active", upstreamPickMode);
    setStatus(upstreamPickMode ? "Klicke Startpunkt auf der Karte." : "Abgebrochen.");
  };
  document.getElementById("btnClearUpstream").onclick = function () {
    var index = parseInt(document.getElementById("featureIndex").value, 10);
    if (index < 0) return;
    delete communityFeatures[index].properties.upstream_node;
    redrawCommunity();
    openEditor(index);
  };

  document.querySelectorAll(".tool-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      startDrawMode(btn.getAttribute("data-draw"));
    });
  });

  document.getElementById("btnTrim").onclick = function () {
    if (trimMode) {
      cancelTrim();
      setStatus("Stutzen abgebrochen.");
      return;
    }
    trimMode = true;
    trimTargetIndex = selectedIndex >= 0 && featureKind(communityFeatures[selectedIndex]) === "waterway"
      ? selectedIndex
      : -1;
    trimSnapPoints = [];
    trimPoints = [];
    clearDrawMode();
    closeAllSidebars();
    document.getElementById("btnTrim").classList.add("active");
    document.getElementById("trimPanel").classList.remove("hidden");
    document.getElementById("btnTrimApply").disabled = true;
    clearTrimPreview();
    if (trimTargetIndex >= 0) {
      var p = communityFeatures[trimTargetIndex].properties || {};
      document.getElementById("trimHint").textContent =
        "„" + (p.name || p.river || "Fluss") + "“ gewählt — Punkt 1 auf der Linie klicken.";
    } else {
      document.getElementById("trimHint").textContent =
        "Flusslinie anklicken, dann 2 Punkte auf der Linie setzen.";
    }
    setStatus("Stutzen: Grün = bleibt, Rot = weg — erst Vorschau, dann Anwenden.");
  };

  document.getElementById("btnTrimApply").onclick = applyTrim;
  document.getElementById("btnTrimCancel").onclick = function () {
    cancelTrim();
    setStatus("Stutzen abgebrochen.");
  };
  document.querySelectorAll('input[name="trimOp"]').forEach(function (radio) {
    radio.addEventListener("change", updateTrimPreview);
  });

  document.addEventListener("keydown", function (e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === "Escape") {
      if (trimMode) {
        cancelTrim();
        setStatus("Stutzen abgebrochen.");
      } else if (selectedIndex >= 0) {
        selectFeature(-1, false);
        closeSidebar();
      }
    }
    if (e.key === "Delete" && selectedIndex >= 0) {
      deleteFeatureAt(selectedIndex);
    }
  });

  document.getElementById("btnPanelGuide").onclick = openGuidePanel;
  document.getElementById("guideRiverSelect").onchange = loadGuideIntoForm;
  document.getElementById("btnGuideAddSection").onclick = function () {
    document.getElementById("guideSections").appendChild(
      createSectionEditor({ name: "", rules: "", notes: "" }, 999)
    );
  };
  document.getElementById("btnGuideSave").onclick = saveGuideLocal;
  document.getElementById("btnGuideClose").onclick = function () {
    guideSidebar.classList.add("hidden");
  };
  document.getElementById("btnGuideNewRiver").onclick = function () {
    var name = prompt("Flussname (muss zu gezeichneten Linien passen):");
    if (!name || !name.trim()) return;
    name = name.trim();
    if (!findGuide(name)) {
      riverGuides.rivers.push({
        river_id: slugify(name),
        river: name,
        description: "",
        sections: []
      });
    }
    refreshGuideRiverSelect();
    document.getElementById("guideRiverSelect").value = name;
    loadGuideIntoForm();
  };

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  function setToken(v) {
    if (v) sessionStorage.setItem(TOKEN_KEY, v);
    else sessionStorage.removeItem(TOKEN_KEY);
  }

  function githubHeaders() {
    var token = getToken();
    if (!token) throw new Error("Kein GitHub-Token.");
    return {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  function fetchSha(apiBase, path) {
    return fetch(apiBase + "/contents/" + path + "?ref=" + BRANCH, { headers: githubHeaders() })
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.message); });
        return r.json().then(function (d) { return d.sha; });
      });
  }

  function putFile(apiBase, path, jsonText, message) {
    var content = btoa(unescape(encodeURIComponent(jsonText)));
    return fetchSha(apiBase, path).then(function (sha) {
      var body = { message: message, content: content, branch: BRANCH };
      if (sha) body.sha = sha;
      return fetch(apiBase + "/contents/" + path, {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, githubHeaders()),
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.message || "HTTP " + r.status);
      });
    });
  }

  function saveToGithub() {
    setStatus("Speichere auf GitHub …");
    document.getElementById("btnSaveRepo").disabled = true;
    var geo = JSON.stringify(buildCommunityCollection(), null, 2) + "\n";
    riverGuides.version = new Date().toISOString().slice(0, 16);
    var guides = JSON.stringify(riverGuides, null, 2) + "\n";
    var poiCount = window.FlowTrailPoi ? FlowTrailPoi.featureCount() : 0;
    var poiJson = window.FlowTrailPoi ? FlowTrailPoi.exportJson() : null;
    putFile(API_BASE, COMMUNITY_PATH, geo, "editor: community map (" + communityFeatures.length + " features)")
      .then(function () {
        return putFile(API_BASE, GUIDES_PATH, guides, "editor: river guides (" + riverGuides.rivers.length + " rivers)");
      })
      .then(function () {
        if (!poiJson) return;
        return putFile(
          POIS_API_BASE,
          POIS_COMMUNITY_PATH,
          poiJson,
          "editor: community pois (" + poiCount + " features)"
        );
      })
      .then(function () {
        if (!window.FlowTrailPoi || !FlowTrailPoi.isRulesDirty()) return;
        var rulesJson = FlowTrailPoi.exportRulesJson();
        if (!rulesJson) return;
        return putFile(API_BASE, "data/rules.json", rulesJson, "editor: pegel rules");
      })
      .then(function () {
        setStatus(
          "Gespeichert. POI-/Fluss-Update in der App; bei neuen Regeln: Action „update-pegel“ (pegel.json)."
        );
      })
      .catch(function (err) {
        setStatus("GitHub: " + err.message);
      })
      .finally(function () {
        document.getElementById("btnSaveRepo").disabled = false;
      });
  }

  document.getElementById("btnExport").onclick = function () {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(buildCommunityCollection(), null, 2)], { type: "application/json" })
    );
    a.download = "community-waterways.geojson";
    a.click();
  };

  document.getElementById("btnSaveRepo").onclick = function () {
    if (!getToken()) {
      document.getElementById("tokenDialog").showModal();
      return;
    }
    saveGuideLocal();
    if (!confirm("Gewässer, Flussführer und POIs in die jeweiligen Repos speichern?")) return;
    saveToGithub();
  };

  document.getElementById("btnToken").onclick = function () {
    document.getElementById("githubToken").value = getToken();
    document.getElementById("tokenDialog").showModal();
  };
  document.getElementById("btnTokenCancel").onclick = function () {
    document.getElementById("tokenDialog").close();
  };
  document.getElementById("btnTokenClear").onclick = function () {
    setToken("");
    setStatus("Token gelöscht.");
  };
  document.getElementById("tokenForm").onsubmit = function (e) {
    e.preventDefault();
    setToken(document.getElementById("githubToken").value.trim());
    document.getElementById("tokenDialog").close();
  };

  map.on("pm:create", function (e) {
    var layer = e.layer;
    map.removeLayer(layer);
    var mode = activeDrawMode || "waterway";
    clearDrawMode();
    var feature;
    if (mode === "einstieg" || mode === "ausstieg") {
      feature = layerToPointFeature(layer, defaultsForDrawMode(mode));
    } else {
      feature = layerToLineFeature(layer, defaultsForDrawMode(mode));
    }
    communityFeatures.push(feature);
    redrawCommunity();
    openEditor(communityFeatures.length - 1);
  });

  map.on("moveend", scheduleMapViewportChange);
  map.on("zoomend", scheduleMapViewportChange);

  document.getElementById("osmFileToggle").onchange = function () {
    if (this.checked && !osmFileLoaded) loadOsmFile();
    else redrawOsmFile();
  };
  document.getElementById("osmLiveToggle").onchange = function () {
    if (this.checked) {
      osmLiveBoundsKey = "";
      scheduleOsmLiveLoad();
    } else {
      if (osmLiveAbort) osmLiveAbort.abort();
      osmLiveBoundsKey = "";
      osmLiveLayer.clearLayers();
      osmLiveFeatures = [];
      updateStatusCounts();
    }
  };

  function loadOsmLiveViewport() {
    if (!document.getElementById("osmLiveToggle").checked) return;
    if (map.getZoom() < OSM_LIVE_MIN_ZOOM) {
      osmLiveLayer.clearLayers();
      osmLiveFeatures = [];
      setStatus("OSM-Live: ab Zoom " + OSM_LIVE_MIN_ZOOM + " (weniger Daten beim Zoomen).");
      return;
    }
    var key = mapViewportKey();
    if (key === osmLiveBoundsKey) return;
    osmLiveBoundsKey = key;
    if (osmLiveAbort) osmLiveAbort.abort();
    osmLiveAbort = new AbortController();
    var b = map.getBounds();
    var q = '[out:json][timeout:25];way["waterway"~"^(river|stream|canal)$"](' +
      b.getSouth() + "," + b.getWest() + "," + b.getNorth() + "," + b.getEast() + ");out geom;";
    setStatus("OSM-Live: lade Ausschnitt …");
    fetch(OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(q),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: osmLiveAbort.signal
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        osmLiveFeatures = (data.elements || []).filter(function (el) {
          return el.type === "way" && el.geometry && el.geometry.length >= 2;
        }).map(function (el) {
          return {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: el.geometry.map(function (n) { return [n.lon, n.lat]; })
            },
            properties: { source: "osm", osm_id: "way/" + el.id, name: (el.tags && el.tags.name) || "" }
          };
        });
        redrawOsmLive();
        updateStatusCounts();
      })
      .catch(function (err) {
        if (err.name === "AbortError") return;
        setStatus("OSM-Live: " + err.message);
      });
  }

  var scheduleOsmLiveLoad = debounce(loadOsmLiveViewport, 900);

  function onMapViewportChange() {
    redrawOsmFile();
    redrawOsmLive();
    if (document.getElementById("osmLiveToggle").checked) scheduleOsmLiveLoad();
  }

  var scheduleMapViewportChange = debounce(onMapViewportChange, 400);

  function normalizeFeature(f) {
    if (!f.properties) f.properties = {};
    if (f.geometry.type === "LineString" && !f.properties.feature_kind) {
      f.properties.feature_kind = "waterway";
      f.properties.source = "community";
    }
    return f;
  }

  function loadCommunity() {
    return fetch(RAW_BASE + COMMUNITY_PATH)
      .then(function (r) {
        if (!r.ok) throw new Error("community HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        communityFeatures = (data.features || []).map(normalizeFeature);
        redrawCommunity();
        if (communityFeatures.length) fitCommunityBounds();
      });
  }

  function loadRiverGuides() {
    return fetch(RAW_BASE + GUIDES_PATH)
      .then(function (r) {
        if (!r.ok) return { version: "", label: "", rivers: [] };
        return r.json();
      })
      .then(function (data) {
        riverGuides = data;
        if (!riverGuides.rivers) riverGuides.rivers = [];
      })
      .catch(function () {
        riverGuides = { version: "", label: "", rivers: [] };
      });
  }

  function loadOsmFile() {
    return fetch(RAW_BASE + "osm-waterways.geojson")
      .then(function (r) { return r.ok ? r.json() : { features: [] }; })
      .then(function (data) {
        osmFileFeatures = data.features || [];
        osmFileLoaded = true;
        redrawOsmFile();
      });
  }

  map.on("click", function (e) {
    if (!upstreamPickMode) return;
    var index = parseInt(document.getElementById("featureIndex").value, 10);
    if (index < 0) return;
    communityFeatures[index].properties.upstream_node = [e.latlng.lng, e.latlng.lat];
    upstreamPickMode = false;
    document.getElementById("btnSetUpstream").classList.remove("active");
    redrawCommunity();
    openEditor(index);
  });

  document.querySelectorAll(".mode-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      setEditorMode(btn.dataset.mode);
    });
  });

  if (window.FlowTrailPoi) {
    FlowTrailPoi.init({
      map: map,
      rawBase: "https://raw.githubusercontent.com/" + POIS_REPO + "/" + BRANCH + "/",
      setStatus: setStatus,
      closeOthers: closeAllSidebars,
      isPoisMode: function () {
        return editorMode === "pois";
      },
      refreshStatus: updateStatusCounts
    });
  }

  setStatus("Karte bereit — lade Gewässer …");
  loadCommunity()
    .then(function () {
      updateStatusCounts();
      setStatus("Gewässer geladen. POIs/Flussführer bei Bedarf (Tab wechseln).");
      loadRiverGuides().then(updateStatusCounts).catch(function () {});
      if (new URLSearchParams(location.search).get("mode") === "pois") {
        setEditorMode("pois");
      }
    })
    .catch(function (err) {
      setStatus("Laden fehlgeschlagen: " + err.message);
    });
})();

(function () {
  "use strict";

  var REPO = "3ddruck12/flowtrail-pegel";
  var BRANCH = "main";
  var RAW_BASE = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/";
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  var VIEWPORT_OSM_LIMIT = 300;

  var map = L.map("map", { zoomControl: false }).setView([51.45, 7.45], 9);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: "© OSM © CARTO",
    maxZoom: 19,
    subdomains: "abcd"
  }).addTo(map);

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
  var osmFileLayer = L.layerGroup().addTo(map);
  var osmLiveLayer = L.layerGroup().addTo(map);

  var communityFeatures = [];
  var osmFileFeatures = [];
  var osmLiveFeatures = [];
  var osmFileLoaded = false;
  var trimMode = false;
  var trimPoints = [];
  var trimTargetIndex = -1;
  var communityLayersByIndex = {};

  var statusBar = document.getElementById("statusBar");
  var sidebar = document.getElementById("sidebar");
  var waterwayForm = document.getElementById("waterwayForm");

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

  function newFeatureId(river) {
    return slugify(river) + "-" + Date.now().toString(36);
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

  function layerToFeature(layer, props) {
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

  function buildCommunityCollection() {
    return {
      type: "FeatureCollection",
      metadata: {
        name: "FlowTrail Community Waterways",
        description: "Von Maintainers gepflegte Kanu-Gewässerlinien.",
        version: new Date().toISOString().slice(0, 16).replace("T", "T")
      },
      features: communityFeatures
    };
  }

  function communityStyle(props) {
    return {
      color: "#0284c7",
      weight: 4,
      opacity: 0.9,
      className: "community-waterway"
    };
  }

  function osmStyle() {
    return {
      color: "#64748b",
      weight: 3,
      opacity: 0.75,
      dashArray: "6 4",
      className: "osm-waterway"
    };
  }

  function osmLiveStyle() {
    return {
      color: "#94a3b8",
      weight: 2,
      opacity: 0.6,
      dashArray: "3 6"
    };
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

  function lineBounds(feature) {
    var layer = featureToLayer(feature, {});
    return layer ? layer.getBounds() : null;
  }

  function featuresInViewport(features, limit) {
    var bounds = map.getBounds();
    var filtered = features.filter(function (f) {
      var b = lineBounds(f);
      return b && bounds.intersects(b);
    });
    if (filtered.length > limit) {
      return filtered.slice(0, limit);
    }
    return filtered;
  }

  function redrawCommunity() {
    communityLayer.clearLayers();
    communityLayersByIndex = {};

    communityFeatures.forEach(function (feature, index) {
      var props = feature.properties || {};
      var layer = featureToLayer(feature, communityStyle(props));
      if (!layer) return;

      layer.on("click", function (e) {
        if (trimMode) {
          handleTrimClick(index, e.latlng);
          L.DomEvent.stopPropagation(e);
          return;
        }
        L.DomEvent.stopPropagation(e);
        openEditor(index);
      });

      layer.addTo(communityLayer);
      communityLayersByIndex[index] = layer;
    });

    updateStatusCounts();
  }

  function bindOsmPopup(layer, feature, adoptFn) {
    var props = feature.properties || {};
    var html =
      "<strong>" + (props.name || "OSM Gewässer") + "</strong><br>" +
      (props.river ? "Fluss: " + props.river + "<br>" : "") +
      (props.osm_id || "") +
      '<br><button type="button" class="btn primary adopt-btn" style="margin-top:8px">Als Community übernehmen</button>';
    layer.bindPopup(html);
    layer.on("popupopen", function () {
      var btn = document.querySelector(".adopt-btn");
      if (btn) {
        btn.onclick = function () {
          adoptFn(feature);
          map.closePopup();
        };
      }
    });
  }

  function redrawOsmFile() {
    osmFileLayer.clearLayers();
    if (!document.getElementById("osmFileToggle").checked) return;

    var visible = featuresInViewport(osmFileFeatures, VIEWPORT_OSM_LIMIT);
    visible.forEach(function (feature) {
      if (isBlockedOsm(feature.properties)) return;
      var layer = featureToLayer(feature, osmStyle());
      if (!layer) return;
      bindOsmPopup(layer, feature, adoptOsmFeature);
      layer.addTo(osmFileLayer);
    });
    updateStatusCounts();
  }

  function redrawOsmLive() {
    osmLiveLayer.clearLayers();
    if (!document.getElementById("osmLiveToggle").checked) return;

    var visible = featuresInViewport(osmLiveFeatures, VIEWPORT_OSM_LIMIT);
    visible.forEach(function (feature) {
      if (isBlockedOsm(feature.properties)) return;
      var layer = featureToLayer(feature, osmLiveStyle());
      if (!layer) return;
      bindOsmPopup(layer, feature, adoptOsmFeature);
      layer.addTo(osmLiveLayer);
    });
    updateStatusCounts();
  }

  function updateStatusCounts() {
    var parts = [communityFeatures.length + " Community-Linien"];
    if (document.getElementById("osmFileToggle").checked && osmFileLoaded) {
      parts.push(osmFileFeatures.length + " OSM-Import gesamt");
    }
    if (document.getElementById("osmLiveToggle").checked) {
      parts.push(osmLiveFeatures.length + " OSM-Live im Speicher");
    }
    setStatus(parts.join(" · "));
  }

  function openEditor(index) {
    var feature = communityFeatures[index];
    if (!feature) return;
    var props = feature.properties || {};
    document.getElementById("featureIndex").value = String(index);
    document.getElementById("wwName").value = props.name || "";
    document.getElementById("wwRiver").value = props.river || "";
    document.getElementById("wwType").value = props.waterway || "river";
    document.getElementById("wwId").value = props.id || "";
    var replaces = props.replaces_osm_ids || [];
    if (typeof replaces === "string") replaces = replaces ? [replaces] : [];
    document.getElementById("wwReplacesOsm").value = replaces.join(", ");
    document.getElementById("replacesRow").classList.toggle("hidden", replaces.length === 0);
    document.getElementById("btnDelete").classList.toggle("hidden", index < 0);
    document.getElementById("sidebarTitle").textContent = "Community-Gewässer bearbeiten";
    sidebar.classList.remove("hidden");
    trimTargetIndex = index;
  }

  function closeSidebar() {
    sidebar.classList.add("hidden");
    document.getElementById("featureIndex").value = "-1";
    trimTargetIndex = -1;
  }

  function adoptOsmFeature(osmFeature) {
    var props = Object.assign({}, osmFeature.properties || {});
    var copy = JSON.parse(JSON.stringify(osmFeature));
    copy.properties = {
      id: newFeatureId(props.river || props.name),
      name: props.name || "Gewässer",
      river: props.river || "",
      waterway: props.waterway || "river",
      source: "community",
      replaces_osm_ids: props.osm_id ? [props.osm_id] : []
    };
    communityFeatures.push(copy);
    redrawCommunity();
    redrawOsmFile();
    redrawOsmLive();
    openEditor(communityFeatures.length - 1);
    setStatus("OSM-Linie übernommen. Bitte prüfen und exportieren.");
  }

  function handleTrimClick(index, latlng) {
    if (index < 0 || !communityFeatures[index]) {
      setStatus("Stutzen: Zuerst eine Community-Linie anklicken.");
      return;
    }
    trimTargetIndex = index;
    trimPoints.push(latlng);
    if (trimPoints.length < 2) {
      setStatus("Stutzen: Zweiten Punkt auf derselben Linie wählen …");
      return;
    }

    var feature = communityFeatures[index];
    try {
      var line = turf.lineString(feature.geometry.coordinates);
      var start = turf.point([trimPoints[0].lng, trimPoints[0].lat]);
      var end = turf.point([trimPoints[1].lng, trimPoints[1].lat]);
      var sliced = turf.lineSlice(start, end, line);
      var fullLen = turf.length(line, { units: "kilometers" });
      var sliceLen = turf.length(sliced, { units: "kilometers" });
      var keepSlice = sliceLen <= fullLen / 2;

      if (keepSlice) {
        feature.geometry.coordinates = sliced.geometry.coordinates;
      } else {
        var merged = turf.lineSlice(end, start, line);
        feature.geometry.coordinates = merged.geometry.coordinates;
      }

      trimPoints = [];
      trimMode = false;
      document.getElementById("btnTrim").classList.remove("active");
      redrawCommunity();
      openEditor(index);
      setStatus("Linie gestutzt (kürzeres Segment behalten). Export nicht vergessen!");
    } catch (err) {
      trimPoints = [];
      setStatus("Stutzen fehlgeschlagen: " + err.message);
    }
  }

  waterwayForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var index = parseInt(document.getElementById("featureIndex").value, 10);
    if (index < 0 || !communityFeatures[index]) return;
    var feature = communityFeatures[index];
    var props = feature.properties;
    props.name = document.getElementById("wwName").value.trim();
    props.river = document.getElementById("wwRiver").value.trim();
    props.waterway = document.getElementById("wwType").value;
    props.id = document.getElementById("wwId").value.trim() || newFeatureId(props.river);
    props.source = "community";
    redrawCommunity();
    closeSidebar();
    setStatus("Gespeichert (lokal). Export nicht vergessen!");
  });

  document.getElementById("btnDelete").addEventListener("click", function () {
    var index = parseInt(document.getElementById("featureIndex").value, 10);
    if (index < 0) return;
    if (!confirm("Diese Community-Linie wirklich löschen?")) return;
    communityFeatures.splice(index, 1);
    redrawCommunity();
    redrawOsmFile();
    redrawOsmLive();
    closeSidebar();
  });

  document.getElementById("btnClose").addEventListener("click", closeSidebar);

  document.getElementById("btnDraw").addEventListener("click", function () {
    trimMode = false;
    trimPoints = [];
    document.getElementById("btnTrim").classList.remove("active");
    map.pm.enableDraw("Line", {
      snappable: true,
      snapDistance: 20,
      allowSelfIntersection: false
    });
    setStatus("Zeichne eine Linie auf der Karte (Doppelklick beendet).");
  });

  document.getElementById("btnTrim").addEventListener("click", function () {
    trimMode = !trimMode;
    trimPoints = [];
    document.getElementById("btnTrim").classList.toggle("active", trimMode);
    map.pm.disableDraw();
    setStatus(
      trimMode
        ? "Stutzen: Community-Linie wählen, dann Start- und Endpunkt auf der Linie setzen."
        : "Stutzen beendet."
    );
  });

  document.getElementById("btnExport").addEventListener("click", function () {
    var json = JSON.stringify(buildCommunityCollection(), null, 2);
    var blob = new Blob([json], { type: "application/geo+json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "community-waterways.geojson";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("Export gestartet. Datei ins Repo legen — merge-waterways Action baut waterways.geojson.");
  });

  map.on("pm:create", function (e) {
    var layer = e.layer;
    map.removeLayer(layer);
    var feature = layerToFeature(layer, {
      id: newFeatureId(""),
      name: "Neues Gewässer",
      river: "",
      waterway: "river",
      source: "community",
      replaces_osm_ids: []
    });
    communityFeatures.push(feature);
    redrawCommunity();
    openEditor(communityFeatures.length - 1);
    setStatus("Neue Linie erstellt. Bitte Fluss/Name eintragen.");
  });

  map.on("moveend", function () {
    redrawOsmFile();
    redrawOsmLive();
    if (document.getElementById("osmLiveToggle").checked) {
      loadOsmLiveViewport();
    }
  });

  document.getElementById("osmFileToggle").addEventListener("change", function () {
    if (this.checked && !osmFileLoaded) {
      loadOsmFile();
    } else {
      redrawOsmFile();
    }
  });

  document.getElementById("osmLiveToggle").addEventListener("change", function () {
    if (this.checked) {
      loadOsmLiveViewport();
    } else {
      osmLiveLayer.clearLayers();
      osmLiveFeatures = [];
      updateStatusCounts();
    }
  });

  function overpassToFeatures(elements) {
    var features = [];
    elements.forEach(function (el) {
      if (el.type !== "way" || !el.geometry || el.geometry.length < 2) return;
      var tags = el.tags || {};
      var osmId = "way/" + el.id;
      var coords = el.geometry.map(function (n) {
        return [n.lon, n.lat];
      });
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: {
          id: osmId.replace("/", "-"),
          name: tags.name || osmId,
          river: tags.name || "",
          waterway: tags.waterway || "river",
          source: "osm",
          osm_id: osmId
        }
      });
    });
    return features;
  }

  var liveLoadTimer = null;
  function loadOsmLiveViewport() {
    if (!document.getElementById("osmLiveToggle").checked) return;
    clearTimeout(liveLoadTimer);
    liveLoadTimer = setTimeout(function () {
      var b = map.getBounds();
      var q =
        '[out:json][timeout:25];' +
        'way["waterway"~"^(river|stream|canal)$"](' +
        b.getSouth() + "," + b.getWest() + "," + b.getNorth() + "," + b.getEast() +
        ');out geom;';
      setStatus("Lade OSM-Live für Kartenausschnitt …");
      fetch(OVERPASS_URL, {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (data) {
          osmLiveFeatures = overpassToFeatures(data.elements || []);
          redrawOsmLive();
          setStatus(osmLiveFeatures.length + " OSM-Live-Linien im Ausschnitt.");
        })
        .catch(function (err) {
          setStatus("OSM-Live Fehler: " + err.message);
        });
    }, 400);
  }

  function loadCommunity() {
    return fetch(RAW_BASE + "community-waterways.geojson")
      .then(function (r) {
        if (!r.ok) throw new Error("community-waterways.geojson HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        communityFeatures = data.features || [];
        redrawCommunity();
      });
  }

  function loadOsmFile() {
    setStatus("Lade osm-waterways.geojson …");
    return fetch(RAW_BASE + "osm-waterways.geojson")
      .then(function (r) {
        if (!r.ok) throw new Error("osm-waterways.geojson HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        osmFileFeatures = data.features || [];
        osmFileLoaded = true;
        redrawOsmFile();
      })
      .catch(function (err) {
        setStatus("OSM-Import-Layer: " + err.message + " (noch nicht importiert?)");
      });
  }

  loadCommunity().catch(function (err) {
    setStatus("Fehler beim Laden: " + err.message);
  });
})();

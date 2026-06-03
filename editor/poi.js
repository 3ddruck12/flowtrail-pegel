(function () {
  "use strict";

  var POI_TYPES = [
    "Einstieg",
    "Ausstieg",
    "Rastplatz",
    "Wehr",
    "Schleuse",
    "Gefahrenstelle",
    "Verboten",
    "Pegel"
  ];
  var PEGEL_RAW =
    "https://raw.githubusercontent.com/3ddruck12/flowtrail-pegel/main/pegel.json";
  var VIEWPORT_OSM_LIMIT = 500;

  var bridge;
  var map;
  var rawBase;
  var pegelSections = [];

  var poiLayer = null;
  var osmWeirLayer = null;
  var poiFeatures = [];
  var osmWeirFeatures = [];
  var osmWeirsLoaded = false;
  var poiAddMode = false;

  var poiSidebar;
  var poiForm;

  function setStatus(msg) {
    bridge.setStatus(msg);
  }

  function pinColor(type) {
    var t = (type || "").toLowerCase();
    if (t.indexOf("einstieg") >= 0) return "#4CAF50";
    if (t.indexOf("ausstieg") >= 0) return "#F44336";
    if (t.indexOf("rast") >= 0) return "#FF9800";
    if (t.indexOf("schleuse") >= 0) return "#2563EB";
    if (t.indexOf("wehr") >= 0) return "#DC2626";
    if (t.indexOf("gefahr") >= 0) return "#9C27B0";
    if (t.indexOf("verboten") >= 0) return "#7c3aed";
    if (t.indexOf("pegel") >= 0) return "#0284c7";
    return "#0078FF";
  }

  function pegelRuleKey(river, station) {
    return (river || "").toLowerCase().trim() + "::" + (station || "").toLowerCase().trim();
  }

  function findPegelSection(river, station) {
    return pegelSections.find(function (s) {
      return s.river === river && s.station === station;
    });
  }

  function refreshPegelRiverSelect() {
    var sel = document.getElementById("pegelRiverSelect");
    var rivers = {};
    pegelSections.forEach(function (s) {
      if (s.river) rivers[s.river] = true;
    });
    var current = sel.value;
    sel.innerHTML = '<option value="">— Fluss wählen —</option>';
    Object.keys(rivers)
      .sort()
      .forEach(function (r) {
        var opt = document.createElement("option");
        opt.value = r;
        opt.textContent = r;
        sel.appendChild(opt);
      });
    if (current && rivers[current]) sel.value = current;
    refreshPegelStationSelect();
  }

  function refreshPegelStationSelect() {
    var river = document.getElementById("pegelRiverSelect").value;
    var sel = document.getElementById("pegelStationSelect");
    var current = sel.value;
    sel.innerHTML = '<option value="">— Messstelle wählen —</option>';
    pegelSections
      .filter(function (s) {
        return s.river === river;
      })
      .sort(function (a, b) {
        return a.station.localeCompare(b.station);
      })
      .forEach(function (s) {
        var opt = document.createElement("option");
        opt.value = s.station;
        var label = s.station;
        if (s.label) label += " (" + s.label + ")";
        opt.textContent = label;
        sel.appendChild(opt);
      });
    if (current) sel.value = current;
    applyPegelSelectionToForm();
  }

  function applyPegelSelectionToForm() {
    var river = document.getElementById("pegelRiverSelect").value;
    var station = document.getElementById("pegelStationSelect").value;
    var sec = findPegelSection(river, station);
    document.getElementById("pegelRuleId").value =
      river && station ? pegelRuleKey(river, station) : "";
    document.getElementById("pegelonlineUuid").value =
      (sec && sec.pegelonline_uuid) || "";
    document.getElementById("pegelExternalId").value =
      (sec && sec.external_station_id) || "";
    var hint = document.getElementById("pegelLiveHint");
    if (!sec) {
      hint.textContent = "";
      return;
    }
    var parts = [];
    if (sec.current != null) parts.push("Stand: " + sec.current + " cm");
    if (sec.label) parts.push(sec.label);
    if (sec.source) parts.push("Quelle: " + sec.source);
    hint.textContent = parts.join(" · ");
    if (!document.getElementById("poiName").value.trim()) {
      document.getElementById("poiName").value = "Pegel " + station;
    }
    document.getElementById("poiRiver").value = river;
  }

  function togglePoiFieldPanels(type) {
    var isPegel = type === "Pegel";
    document.getElementById("poiPegelFields").classList.toggle("hidden", !isPegel);
    document.getElementById("poiGenericFields").classList.toggle("hidden", isPegel);
  }

  function loadPegelCatalog() {
    return fetch(PEGEL_RAW)
      .then(function (r) {
        if (!r.ok) throw new Error("pegel.json HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        pegelSections = data.sections || [];
        refreshPegelRiverSelect();
      })
      .catch(function (err) {
        setStatus("Pegel-Katalog: " + err.message);
      });
  }

  function makeCommunityIcon(type) {
    var label = (type || "P").substring(0, 3);
    if ((type || "").toLowerCase().indexOf("pegel") >= 0) label = "Pe";
    return L.divIcon({
      className: "",
      html:
        '<div class="community-pin" style="background:' +
        pinColor(type) +
        '"><span>' +
        label +
        "</span></div>",
      iconSize: [22, 22],
      iconAnchor: [11, 22]
    });
  }

  function makeOsmIcon() {
    return L.divIcon({
      className: "",
      html: '<div class="osm-pin"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
  }

  function featureLatLng(feature) {
    var c = feature.geometry.coordinates;
    return L.latLng(c[1], c[0]);
  }

  function newCommunityFeature(lat, lng, props) {
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: Object.assign(
        {
          name: "Neuer POI",
          description: "",
          type: "Einstieg",
          river: "",
          source: "community"
        },
        props || {}
      )
    };
  }

  function buildCommunityCollection() {
    return {
      type: "FeatureCollection",
      metadata: {
        name: "FlowTrail Community POIs",
        description: "Von Maintainers und Community gepflegte Kanu-POIs.",
        version: new Date().toISOString().slice(0, 16).replace("T", "T")
      },
      features: poiFeatures
    };
  }

  function redrawPois() {
    poiLayer.clearLayers();
    poiFeatures.forEach(function (feature, index) {
      var props = feature.properties;
      var marker = L.marker(featureLatLng(feature), {
        icon: makeCommunityIcon(props.type),
        draggable: bridge.isPoisMode()
      }).addTo(poiLayer);

      marker.on("dragend", function () {
        var ll = marker.getLatLng();
        feature.geometry.coordinates = [ll.lng, ll.lat];
      });
      marker.on("click", function (e) {
        L.DomEvent.stopPropagation(e);
        if (!bridge.isPoisMode()) return;
        openPoiEditor(index);
      });
    });
    bridge.refreshStatus();
  }

  function featuresInViewport(features, limit) {
    var bounds = map.getBounds();
    var filtered = features.filter(function (f) {
      return bounds.contains(featureLatLng(f));
    });
    if (filtered.length > limit) return filtered.slice(0, limit);
    return filtered;
  }

  function redrawOsmWeirs() {
    osmWeirLayer.clearLayers();
    if (!document.getElementById("poiOsmToggle").checked) return;
    if (!bridge.isPoisMode()) return;

    var visible = featuresInViewport(osmWeirFeatures, VIEWPORT_OSM_LIMIT);
    visible.forEach(function (feature) {
      var props = feature.properties || {};
      var blocked = poiFeatures.some(function (c) {
        return c.properties.replaces_osm_id === props.osm_id;
      });
      if (blocked) return;

      var marker = L.marker(featureLatLng(feature), { icon: makeOsmIcon() }).addTo(osmWeirLayer);
      marker.bindPopup(
        "<b>" +
          (props.name || "OSM Wehr") +
          "</b><br>" +
          (props.description || "") +
          '<br><button type="button" class="btn primary poi-adopt-btn" data-osm-id="' +
          (props.osm_id || "") +
          '">Als Community-POI übernehmen</button>'
      );
      marker.on("popupopen", function () {
        var btn = document.querySelector(
          ".poi-adopt-btn[data-osm-id='" + props.osm_id + "']"
        );
        if (btn) {
          btn.onclick = function () {
            adoptOsmWeir(feature);
            map.closePopup();
          };
        }
      });
    });
    bridge.refreshStatus();
  }

  function openPoiEditor(index) {
    var feature = poiFeatures[index];
    if (!feature) return;
    bridge.closeOthers();
    var props = feature.properties;
    var type = POI_TYPES.indexOf(props.type) >= 0 ? props.type : "Einstieg";
    document.getElementById("poiIndex").value = String(index);
    document.getElementById("poiName").value = props.name || "";
    document.getElementById("poiType").value = type;
    document.getElementById("poiRiver").value = props.pegel_river || props.river || "";
    document.getElementById("poiDescription").value = props.description || "";
    togglePoiFieldPanels(type);
    if (type === "Pegel") {
      var river = props.pegel_river || props.river || "";
      var station = props.pegel_station || "";
      document.getElementById("pegelRiverSelect").value = river;
      refreshPegelStationSelect();
      document.getElementById("pegelStationSelect").value = station;
      document.getElementById("pegelRuleId").value = props.pegel_rule_id || "";
      document.getElementById("pegelonlineUuid").value = props.pegelonline_uuid || "";
      document.getElementById("pegelExternalId").value = props.external_station_id || "";
      applyPegelSelectionToForm();
    }
    var replaces = props.replaces_osm_id || "";
    document.getElementById("poiReplacesRow").classList.toggle("hidden", !replaces);
    document.getElementById("poiReplacesOsm").value = replaces;
    document.getElementById("btnPoiDelete").classList.toggle("hidden", index < 0);
    poiSidebar.classList.remove("hidden");
  }

  function closePoiSidebar() {
    poiSidebar.classList.add("hidden");
    document.getElementById("poiIndex").value = "-1";
  }

  function adoptOsmWeir(osmFeature) {
    var props = osmFeature.properties || {};
    var ll = featureLatLng(osmFeature);
    var feature = newCommunityFeature(ll.lat, ll.lng, {
      name: props.name || "Wehr",
      description: props.description || "",
      type: props.type || "Wehr",
      river: props.river || "",
      source: "community",
      replaces_osm_id: props.osm_id || ""
    });
    poiFeatures.push(feature);
    redrawPois();
    redrawOsmWeirs();
    openPoiEditor(poiFeatures.length - 1);
    setStatus("OSM-Wehr als Community-POI übernommen.");
  }

  function loadCommunity() {
    return fetch(rawBase + "community-pois.geojson")
      .then(function (r) {
        if (!r.ok) throw new Error("community-pois.geojson HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        poiFeatures = data.features || [];
        redrawPois();
      });
  }

  function loadOsmWeirs() {
    setStatus("Lade OSM-Wehre …");
    return fetch(rawBase + "osm-weirs.geojson")
      .then(function (r) {
        if (!r.ok) throw new Error("osm-weirs.geojson HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        osmWeirFeatures = data.features || [];
        osmWeirsLoaded = true;
        redrawOsmWeirs();
      })
      .catch(function (err) {
        setStatus("OSM-Wehre: " + err.message);
      });
  }

  window.FlowTrailPoi = {
    init: function (b) {
      bridge = b;
      map = b.map;
      rawBase = b.rawBase;
      poiLayer = L.layerGroup().addTo(map);
      osmWeirLayer = L.layerGroup().addTo(map);
      poiSidebar = document.getElementById("poiSidebar");
      poiForm = document.getElementById("poiForm");

      poiForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var index = parseInt(document.getElementById("poiIndex").value, 10);
        if (index < 0 || !poiFeatures[index]) return;
        var props = poiFeatures[index].properties;
        props.name = document.getElementById("poiName").value.trim();
        props.type = document.getElementById("poiType").value;
        props.description = document.getElementById("poiDescription").value.trim();
        props.source = "community";
        if (props.type === "Pegel") {
          var pRiver = document.getElementById("pegelRiverSelect").value.trim();
          var pStation = document.getElementById("pegelStationSelect").value.trim();
          if (!pRiver || !pStation) {
            setStatus("Pegel-POI: Fluss und Messstelle auswählen.");
            return;
          }
          props.pegel_river = pRiver;
          props.pegel_station = pStation;
          props.river = pRiver;
          props.pegel_rule_id = pegelRuleKey(pRiver, pStation);
          props.pegelonline_uuid =
            document.getElementById("pegelonlineUuid").value.trim() || null;
          props.external_station_id =
            document.getElementById("pegelExternalId").value.trim() || null;
          delete props.replaces_osm_id;
        } else {
          props.river = document.getElementById("poiRiver").value.trim();
          delete props.pegel_river;
          delete props.pegel_station;
          delete props.pegel_rule_id;
          delete props.pegelonline_uuid;
          delete props.external_station_id;
        }
        redrawPois();
        closePoiSidebar();
        bridge.refreshStatus();
      });

      document.getElementById("btnPoiDelete").addEventListener("click", function () {
        var index = parseInt(document.getElementById("poiIndex").value, 10);
        if (index < 0) return;
        if (!confirm("Diesen Community-POI wirklich löschen?")) return;
        poiFeatures.splice(index, 1);
        redrawPois();
        redrawOsmWeirs();
        closePoiSidebar();
        bridge.refreshStatus();
      });

      document.getElementById("btnPoiClose").addEventListener("click", closePoiSidebar);

      document.getElementById("poiType").addEventListener("change", function () {
        togglePoiFieldPanels(document.getElementById("poiType").value);
      });
      document.getElementById("pegelRiverSelect").addEventListener("change", refreshPegelStationSelect);
      document.getElementById("pegelStationSelect").addEventListener("change", applyPegelSelectionToForm);

      document.getElementById("btnPoiAdd").addEventListener("click", function () {
        poiAddMode = !poiAddMode;
        document.getElementById("btnPoiAdd").classList.toggle("active", poiAddMode);
        setStatus(
          poiAddMode
            ? "Klicke auf die Karte, um einen Navigation-POI zu setzen."
            : "POI-Setzen beendet."
        );
      });

      document.getElementById("poiOsmToggle").addEventListener("change", function () {
        if (this.checked && !osmWeirsLoaded) loadOsmWeirs();
        else redrawOsmWeirs();
      });

      document.getElementById("btnPoiExport").addEventListener("click", function () {
        var json = JSON.stringify(buildCommunityCollection(), null, 2);
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], { type: "application/geo+json" }));
        a.download = "community-pois.geojson";
        a.click();
        URL.revokeObjectURL(a.href);
      });

      map.on("click", function (e) {
        if (!bridge.isPoisMode() || !poiAddMode) return;
        poiFeatures.push(newCommunityFeature(e.latlng.lat, e.latlng.lng, {}));
        poiAddMode = false;
        document.getElementById("btnPoiAdd").classList.remove("active");
        redrawPois();
        openPoiEditor(poiFeatures.length - 1);
      });

      map.on("moveend", redrawOsmWeirs);
    },

    load: function () {
      return Promise.all([loadCommunity(), loadPegelCatalog()]);
    },

    closeSidebar: closePoiSidebar,

    onModeChange: function (mode) {
      poiAddMode = false;
      document.getElementById("btnPoiAdd").classList.remove("active");
      redrawPois();
      redrawOsmWeirs();
    },

    getStatusSuffix: function () {
      return " · " + poiFeatures.length + " Navigation-POIs";
    },

    exportJson: function () {
      return JSON.stringify(buildCommunityCollection(), null, 2) + "\n";
    },

    featureCount: function () {
      return poiFeatures.length;
    }
  };
})();

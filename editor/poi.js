(function () {
  "use strict";

  var POI_TYPES = [
    "Einstieg",
    "Ausstieg",
    "Rastplatz",
    "Wehr",
    "Schleuse",
    "Gefahrenstelle",
    "Verboten"
  ];
  var VIEWPORT_OSM_LIMIT = 500;

  var bridge;
  var map;
  var rawBase;

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
    return "#0078FF";
  }

  function makeCommunityIcon(type) {
    var label = (type || "P").substring(0, 3);
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
    document.getElementById("poiIndex").value = String(index);
    document.getElementById("poiName").value = props.name || "";
    document.getElementById("poiType").value =
      POI_TYPES.indexOf(props.type) >= 0 ? props.type : "Einstieg";
    document.getElementById("poiRiver").value = props.river || "";
    document.getElementById("poiDescription").value = props.description || "";
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
        props.river = document.getElementById("poiRiver").value.trim();
        props.description = document.getElementById("poiDescription").value.trim();
        props.source = "community";
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

    load: loadCommunity,

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

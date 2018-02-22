// Copyright 2016, Lewis Liu(lewisliu116@gmail.com)
// Licensed under the Apache License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

process.env.DEBUG = 'actions-on-google:*';

const url = require('url');
const { DialogflowApp, Responses } = require('actions-on-google');
const { RichResponse, BasicCard } = Responses;
const functions = require('firebase-functions');
const maps = require('@google/maps');
const Request = require('request');

const config = functions.config();

const client = maps.createClient({
  key: config.maps.key
});

// Dialogflow actions
const Actions = {
  WELCOME: 'input.welcome',
  REQUEST_LOC_PERMISSION: 'request.location.permission',
  HANDLE_DATA: 'handle.data',
  UNHANDLED_DEEP_LINK: 'deeplink.unknown',
  CUSTOM_ADDRESS: 'address.address-fallback'
};

// AIRMAP
const AIRMAP_URL = "https://api.airmap.com/status/v2/point/?latitude=<LAT>&longitude=<LONG>&weather=true&types=airport,controlled_airspace,special_use_airspace,school,tfr";
const APP_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjcmVkZW50aWFsX2lkIjoiY3JlZGVudGlhbHxkUW5XTGJnSG9OWE41WmNlNVI1WEVUeXpiZDNCIiwiYXBwbGljYXRpb25faWQiOiJhcHBsaWNhdGlvbnw4UnBSMktkVXhMUE80UFNKcUt3UnpVNXhPUXc4Iiwib3JnYW5pemF0aW9uX2lkIjoiZGV2ZWxvcGVyfEtkNzJLZXVZTEQzbVJVNDZNNk9RdW9YTDJ4bCIsImlhdCI6MTUxODkyNDg1MH0.ycVBhUCro7EyNrUzWa-mpl7kjuiAXGFlWo4fmo8OFMM";
var DEFAULT_LAT;
var DEFAULT_LONG;
var DEFFAULT_CITY;

// Google Map API
const STATIC_MAPS_ADDRESS = 'https://maps.googleapis.com/maps/api/staticmap';
const STATIC_MAPS_SIZE = '600x400';
const staticMapsURL = url.parse(STATIC_MAPS_ADDRESS);
staticMapsURL.query = {
  key: config.maps.key,
  size: STATIC_MAPS_SIZE
};

/**
 * Constructs a rich response consisting of a simple response and a basic card whose image shows
 * a Static Maps view centered on a city.
 *
 * @param {string} city
 * @param {string} speech
 */
const locationResponse = (city, speech) => {
  staticMapsURL.query.center = city;
  const mapViewURL = url.format(staticMapsURL);
  return new RichResponse()
    .addSimpleResponse(speech)
    .addBasicCard(new BasicCard().setImage(mapViewURL, 'Location Map'));
};

/**
 * Sanitize template literal inputs by escaping characters into XML entities to use in SSML
 * Also normalize the extra spacing for better text rendering in SSML
 * A tag function used by ES6 tagged template literals
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals#Tagged_template_literals
 *
 * @example
 * const equation = '"1 + 1 > 1"';
 * const response = ssml`
 *   <speak>
 *     ${equation}
 *   </speak>
 * `;
 * // Equivalent to ssml`\n  <speak>\n    ${equation}\n  </speak>\n`
 * console.log(response);
 * // Prints: '<speak>&quot;1 + 1 &gt; 1&quot;</speak>'
 *
 * @param {TemplateStringsArray} template Non sanitized constant strings in the template literal
 * @param {Array<string>} inputs Computed expressions to be sanitized surrounded by ${}
 */
const ssml = (template, ...inputs) => template.reduce((out, str, i) => i
  ? out + (
    inputs[i - 1]
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  ) + str
  : str
).trim().replace(/\s+/g, ' ').replace(/ </g, '<').replace(/> /g, '>');

const COLOR_CODE = {
	"red" : "Flight is strictly restricted in this area",
	"orange" : "Flight is regulated in this area and requires authorization to fly",
	"yellow" : "There are known advisories in this area and caution should be used",
	"green" :"There are no known advisories in this area"
}

const responses = {
  /** @param {string} city 
	* @param {string} color
	*/
  sayLocation: (city, color, def, weather, wind) => locationResponse(city, ssml`
	      <speak>
	        The flight code at your location ${city} is ${color}.<break time="500ms"/>${def}.<break time="500ms"/>
	        Weather condition is ${weather} and wind speed is ${wind} <sub alias="kilometer per hour">km/h</sub>.
	      </speak>
	    `),
  greetUser: ssml`
    <speak>
      Welcome to <sub alias="Fly Drone">FlyDrone</sub>!
      <break time="500ms"/>
  	  I can find air control and weather information for you.
      Would you prefer use your location or a different address?
    </speak>
  `,
  /** @param {string} input */
  unhandledDeepLinks: input => ssml`
    <speak>
      We will build more deep link soon, please try it later!
    </speak>
  `,
  flyDroneError: ssml`
    <speak>
      Oops!
      <break time="1s"/>
      We are not able to get the flight information for you at the moment.
      Ask me again later.
    </speak>
  `,
  coarseLocation: city => ssml`
    <speak>
      We found you in ${city}. <break time="500ms"/> But you might be on a speaker device.
      <break time="500ms"/>
      You location is not precise enough to give good safety recommendation.
	  <break time="500ms"/>
	  Consider to use a phone with GSP. Good luck.
    </speak>
  `,
  permissionReason: 'To locate where you are',
  notificationText: 'See you where you are...'
};

/**
 * @typedef {Object} AppData
 * @property {string=} requestedPermission
 */

class FlyDrone {
  /**
   * @param {ExpressRequest} req
   * @param {ExpressResponse} res
   */
  constructor (req, res) {
    console.log('Headers', JSON.stringify(req.headers, null, 2));
    console.log('Body', JSON.stringify(req.body, null, 2));

    this.app = new DialogflowApp({
      request: req,
      response: res
    });

    /** @type {AppData} */
    this.data = this.app.data;
    this.permissions = this.app.SupportedPermissions;
  }

  run () {
    /** @type {*} */
    const map = this;
    const action = this.app.getIntent();
    console.log(action);
    if (!action) {
      return this.app.tell(responses.flyDroneError);
    }
    const result = map[action]();
    if (result instanceof Promise) {
      result.catch(/** @param {Error} e */ e => {
        console.log('Error', e.toString(), e.stack);
        this.app.tell(responses.flyDroneError);
      });
    }
  }

  /**
   * Gets the city name from results returned by Google Maps reverse geocoding from coordinates.
   * @param {number} latitude
   * @param {number} longitude
   * @return {Promise<string>}
   */
  coordinatesToCity (latitude, longitude) {
    const latlng = [latitude, longitude];
    return new Promise((resolve, reject) => client.reverseGeocode({ latlng },
      /**
       * @param {Error} e
       * @param {Object<string, *>} response
       */
      (e, response) => {
        if (e) {
          return reject(e);
        }
        const { results } = response.json;
        /** @type {Array<Object<string, *>>} */
        const components = results[0].address_components;
        for (const component of components) {
          for (const type of component.types) {
            if (type === 'locality') {
              return resolve(component.long_name);
            }
          }
        }
        reject(new Error('Could not parse city name from Google Maps results'));
      }
    ));
  }
  
 /**
  * Gets the coordinates from results returned by Google Maps geocoding from address.
  * @param {string} address
  * @return {Promise geo[lat, long]}
  */
  cityToCoordniates (address) {
      return new Promise((resolve, reject) => client.geocode({ address },
        /**
         * @param {Error} e
         * @param {Object<string, *>} response
         */
        (e, response) => {
          if (e) {
            return reject(e);
          }
          const { results } = response.json;
          /** @type {Array<Object<string, *>>} */
          const gloc = results[0].geometry.location;
		  console.log(results[0].geometry.location);
          if (gloc) {
			  const latitude = gloc.lat;
			  const longitude = gloc.lng;
			  return resolve({latitude, longitude});
          }
          reject(new Error('Could not obtain coornidate from Google Maps results'));
        }
      ));
  }

  fetchAirMap() {
	  if (!this.DEFAULT_CITY && (!this.DEFAULT_LAT || !this.DEFAULT_LONG)) {
		  return Promise.reject(new Error('We cannot resolve the location.'));
	  }
	const url = AIRMAP_URL.replace("<LAT>", this.DEFAULT_LAT).replace("<LONG>", this.DEFAULT_LONG);
	console.log(url);
	var options = {
	  url: url,
	  headers: {
	    'X-API-Key': APP_KEY
	  }
	};
	Request(options, (error, response, body) => {
		if (!error && response.statusCode == 200) {
			var info = JSON.parse(body);
			console.log(info.data.advisory_color + ", " + COLOR_CODE[info.data.advisory_color] + ", " + info.data.weather.condition + ", "+ info.data.weather.wind.speed);
			return this.app.tell(responses.sayLocation(this.DEFAULT_CITY, info.data.advisory_color, COLOR_CODE[info.data.advisory_color],  info.data.weather.condition, info.data.weather.wind.speed.toString()));
		}
		console.log(error);
		console.log(response.statusCode);
		return Promise.reject(new Error('We cannot retrieve flight data at the moment'));
	});
  }
  
  [Actions.WELCOME] () {
    this.app.ask(responses.greetUser);
  }

  [Actions.UNHANDLED_DEEP_LINK] () {
    this.app.ask(responses.unhandledDeepLinks(this.app.getRawInput()));
  }

  [Actions.REQUEST_LOC_PERMISSION] () {
    // If the request comes from a phone, we can't use coarse location.
    const requestedPermission = this.app.hasSurfaceCapability(this.app.SurfaceCapabilities.SCREEN_OUTPUT)
      ? this.permissions.DEVICE_PRECISE_LOCATION
      : this.permissions.DEVICE_COARSE_LOCATION;
    this.data.requestedPermission = requestedPermission;
    if (!this.app.isPermissionGranted()) {
       return this.app.askForPermission(responses.permissionReason, requestedPermission);
    }
  }
  
  [Actions.CUSTOM_ADDRESS] () {
	  console.log("query user input address: " + this.app.getRawInput());
	  this.DEFAULT_CITY = this.app.getRawInput();
  	  return this.cityToCoordniates(this.app.getRawInput()).then(geo => {
  	  	  this.DEFAULT_LAT = geo.latitude;
  		  this.DEFAULT_LONG = geo.longitude;
  		  console.log("calling from aprox location subroutine");
  		  this.fetchAirMap();
		  
  	  });
  }
  
  [Actions.HANDLE_DATA] () {
      if (!this.app.isPermissionGranted()) {
        return Promise.reject(new Error('Permission not granted'));
      }
      const requestedPermission = this.data.requestedPermission;
      if (requestedPermission === this.permissions.DEVICE_COARSE_LOCATION) {
        // If we requested coarse location, it means that we're on a speaker device.
        this.DEFAULT_CITY = this.app.getDeviceLocation().city;
  	    this.app.tell(responses.coarseLocation(this.DEFAULT_CITY));
      }
      if (requestedPermission === this.permissions.DEVICE_PRECISE_LOCATION) {
        // If we requested precise location, it means that we're on a phone.
        // Because we will get only latitude and longitude, we need to reverse geocode
        // to get the city.
        const { coordinates } = this.app.getDeviceLocation();
  	    this.DEFAULT_LAT= coordinates.latitude;
  	    this.DEFAULT_LONG = coordinates.longitude;
  	    console.log("caching exact location: " + this.DEFAULT_LAT + "," + this.DEFAULT_LONG  + "]");
        return this.coordinatesToCity(coordinates.latitude, coordinates.longitude)
          .then(city => {
            this.DEFAULT_CITY = city;
  		  console.log("calling from exact location subroutine");
  		  this.fetchAirMap();
          });
      }
      return Promise.reject(new Error('Unrecognized permission'));
  }
}

exports.flyDrone = functions.https.onRequest((req, res) => new FlyDrone(req, res).run());

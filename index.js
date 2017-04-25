'use strict';
const https = require('https');
const COOKIE = require('cookie');
const jsdom = require('jsdom');
const cluster = require('cluster');
const Promise = require("bluebird");
const vm = require('vm');

module.exports = function (path) {
  const proxies = require('proxies')(path);

  return {
    jsdom ( conf ) {
      return proxies.getAgent()
      .then((agent) => {
        let rootPromise = new Promise((res, rej) => {
          console.log(`GET : ${conf.url}`);

          let nConf = Object.assign({}, conf, {
            agent,
            done: function(err, win) {
              if (err) rej(err);
              else res(win);
            }
          })

          jsdom.env(nConf);
        });

        if (conf.timeout) return rootPromise.timeout(conf.timeout);
        else return rootPromise;
      });
    },

    runGenerator ( gen ) {
      let args = [].slice.call( arguments, 1 ), it;
      it = gen.apply(this,args);

      return Promise.resolve()
      .then(function hendleNext (value) {
        let next = it.next(value);

        return (function hendleResult (next) {
          if (next.done) return next.value;
          else {
            return Promise.resolve(next.value)
            .then(
              hendleNext,
              function hendleError (err) {
                return Promise.resolve( it.throw(err) )
                .then( hendleResult )
              }
            )
          }
        })(next)
      });
    },

    loadByPath ( options = {} ) {
      let {
        hostname,
        path,
        method='GET',
        data=void 0,
        headers=void 0,
        HTTP=https,
        timeout=void 0,
        rejectUnauthorized=true,
        family=void 0
      } = options;
      console.log(`IP: ${method}: ${path}`);

      return proxies.getAgent()
      .then((agent) => {
        let rootPromise = new Promise((resolve,reject)=>{
          let req = HTTP.request({hostname,path,method,headers,rejectUnauthorized,family,agent}, (res) => {

            if (res.statusCode === 200) {
              let answer = Buffer.allocUnsafe(0);
              res.on('data', (chunk) => {
                answer = Buffer.concat([answer, chunk], answer.length + chunk.length);
              });

              res.on('end', () => {
                resolve({res,body:answer});
              });
            } else if (~[301,302].indexOf(res.statusCode)) {
              resolve({res});
            } else reject(res.statusCode);
          });

          req.on('error', (e) => {
            reject(e);
          });

          req.on('socket', (socket) => {
            if (timeout) {
              socket.setTimeout(timeout);
              socket.on('timeout', function() {
                req.abort();
              });
            }
          });

          if (data) {
            req.write(data);
          }

          req.end();
        });

        if (timeout) return rootPromise.timeout(timeout)
        else return rootPromise;
      });
    },

    slaceArray ( arr, countStream ) {
      arr = [].concat(arr);
      let res = [];

      while (arr.length) {
        let r = [];
        for(let i = 0; i < countStream && arr.length; i++){
          r.push(arr.pop());
        }
        if (r.length) res.push(r);
      }

      return res;
    },

    sleep ( ms ) {
      return new Promise((res) => {
        setTimeout(res,ms);
      });
    },

    runScript (script) {
      let data = null;

      let sandbox = {
        'document' : {
          'aip_list': {
            'create_prebuilt_event' : (d) => data = d
          }
        }
      };

      vm.runInNewContext(script, sandbox);

      return data;
    },

    COOKIE : {
      encode ( cookies ) {
        return Object.keys(cookies).map((name) => COOKIE.serialize(name, cookies[name])).join('; ');
      },

      decode ( headers ) {
        let cookies = {};
        headers['set-cookie'].forEach((item) => {
          let c = COOKIE.parse(item);
          let name = Object.keys(c)[0];
          cookies[name] = c[name];
        });

        return cookies;
      },

      parse ( cookie ) {
        return COOKIE.parse(cookie);
      }
    },

    WorkersContainer : class WorkersContainer {
      constructor (count, settings = null) {
        this.workers = Array.from(new Array(count))
        .map(() => {
          if (settings) cluster.setupMaster(settings);
          return cluster.fork();
        });

        this.items = null;
        this.updateEventList();
      }

      updateEventList () {
        this.items = Promise.all(
          this.workers.map((w) => {
            return WorkersContainer.sendAndReceive(w, { type: 'events' })
            .then((list) => ({
              id: w.id,
              list
            }))
          })
        );
      }

      isInWorker (eid) {
        return this.items
        .then((list) => list.some((e) => ~e.list.indexOf(eid)));
      }

      insertEventId (event) {
        return this._getMinList()
        .then((w) => {
          w.list.push(event.eid);
          return WorkersContainer.sendAndReceive(cluster.workers[w.id], { type: 'insert-event-id', data: event });
        })
      }

      _getMinList () {
        return this.items
        .then((workers) => {
          let ans = workers[0];

          for (let w of workers) {
            if (ans.list.length > w.list.length) ans = w;
          }

          return ans;
        })
      }

      static sendAndReceive (worker, data) {
        return new Promise((res, rej) => {
          let uid = Math.floor(Math.random() * 10000);
          worker.on('message', function listener (ans) {
            if ( ans.uid === uid ) {
              this.removeListener('message',listener);
              if (ans.error) rej(ans.error);
              else res(ans.data);
            }
          });

          worker.send(Object.assign({}, data, { uid }));
        });
      }
    }
  }
};

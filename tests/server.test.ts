import { v4 as uuid } from "uuid";
import dayjs from "dayjs";
import request from "supertest";
import {  MusicService } from "../src/music_service";
import makeServer, { BONOB_ACCESS_TOKEN_HEADER } from "../src/server";
import { SONOS_DISABLED, Sonos, Device } from "../src/sonos";

import { aDevice, aService } from "./builders";
import { InMemoryMusicService } from "./in_memory_music_service";
import { ExpiringAccessTokens } from "../src/access_tokens";
import { InMemoryLinkCodes } from "../src/link_codes";

describe("server", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
  });

  describe("/", () => {
    describe("when sonos integration is disabled", () => {
      const server = makeServer(
        SONOS_DISABLED,
        aService(),
        "http://localhost:1234",
        new InMemoryMusicService()
      );

      describe("devices list", () => {
        it("should be empty", async () => {
          const res = await request(server).get("/").send();

          expect(res.status).toEqual(200);
          expect(res.text).not.toMatch(/class=device/);
        });
      });
    });

    describe("when there are 2 devices and bonob is not registered", () => {
      const service1 = aService({
        name: "s1",
        sid: 1,
      });
      const service2 = aService({
        name: "s2",
        sid: 2,
      });
      const service3 = aService({
        name: "s3",
        sid: 3,
      });
      const service4 = aService({
        name: "s4",
        sid: 4,
      });
      const missingBonobService = aService({
        name: "bonobMissing",
        sid: 88,
      });

      const device1: Device = aDevice({
        name: "device1",
        ip: "172.0.0.1",
        port: 4301,
      });

      const device2: Device = aDevice({
        name: "device2",
        ip: "172.0.0.2",
        port: 4302,
      });

      const fakeSonos: Sonos = {
        devices: () => Promise.resolve([device1, device2]),
        services: () =>
          Promise.resolve([service1, service2, service3, service4]),
        register: () => Promise.resolve(false),
      };

      const server = makeServer(
        fakeSonos,
        missingBonobService,
        "http://localhost:1234",
        new InMemoryMusicService()
      );

      describe("devices list", () => {
        it("should contain the devices returned from sonos", async () => {
          const res = await request(server).get("/").send();

          expect(res.status).toEqual(200);
          expect(res.text).toMatch(/device1\s+\(172.0.0.1:4301\)/);
          expect(res.text).toMatch(/device2\s+\(172.0.0.2:4302\)/);
        });
      });

      describe("services", () => {
        it("should contain a list of services returned from sonos", async () => {
          const res = await request(server).get("/").send();

          expect(res.status).toEqual(200);
          expect(res.text).toMatch(/Services\s+4/);
          expect(res.text).toMatch(/s1\s+\(1\)/);
          expect(res.text).toMatch(/s2\s+\(2\)/);
          expect(res.text).toMatch(/s3\s+\(3\)/);
          expect(res.text).toMatch(/s4\s+\(4\)/);
        });
      });

      describe("registration status", () => {
        it("should be not-registered", async () => {
          const res = await request(server).get("/").send();
          expect(res.status).toEqual(200);
          expect(res.text).toMatch(/No existing service registration/);
        });
      });
    });

    describe("when there are 2 devices and bonob is registered", () => {
      const service1 = aService();

      const service2 = aService();

      const bonobService = aService({
        name: "bonobNotMissing",
        sid: 99,
      });

      const fakeSonos: Sonos = {
        devices: () => Promise.resolve([]),
        services: () => Promise.resolve([service1, service2, bonobService]),
        register: () => Promise.resolve(false),
      };

      const server = makeServer(
        fakeSonos,
        bonobService,
        "http://localhost:1234",
        new InMemoryMusicService()
      );

      describe("registration status", () => {
        it("should be registered", async () => {
          const res = await request(server).get("/").send();
          expect(res.status).toEqual(200);
          expect(res.text).toMatch(/Existing service config/);
        });
      });
    });
  });

  describe("/register", () => {
    const sonos = {
      register: jest.fn(),
    };
    const theService = aService({
      name: "We can all live a life of service",
      sid: 999,
    });
    const server = makeServer(
      (sonos as unknown) as Sonos,
      theService,
      "http://localhost:1234",
      new InMemoryMusicService()
    );

    describe("when is succesfull", () => {
      it("should return a nice message", async () => {
        sonos.register.mockResolvedValue(true);

        const res = await request(server).post("/register").send();

        expect(res.status).toEqual(200);
        expect(res.text).toMatch("Successfully registered");

        expect(sonos.register.mock.calls.length).toEqual(1);
        expect(sonos.register.mock.calls[0][0]).toBe(theService);
      });
    });

    describe("when is unsuccesfull", () => {
      it("should return a failure message", async () => {
        sonos.register.mockResolvedValue(false);

        const res = await request(server).post("/register").send();

        expect(res.status).toEqual(500);
        expect(res.text).toMatch("Registration failed!");

        expect(sonos.register.mock.calls.length).toEqual(1);
        expect(sonos.register.mock.calls[0][0]).toBe(theService);
      });
    });
  });

  describe("/stream", () => {
    const musicService = {
      login: jest.fn(),
    };
    const musicLibrary = {
      stream: jest.fn(),
      scrobble: jest.fn()
    };
    let now = dayjs();
    const accessTokens = new ExpiringAccessTokens({ now: () => now });

    const server = makeServer(
      (jest.fn() as unknown) as Sonos,
      aService(),
      "http://localhost:1234",
      (musicService as unknown) as MusicService,
      new InMemoryLinkCodes(),
      accessTokens
    );

    const authToken = uuid();
    const trackId = uuid();
    let accessToken: string;

    beforeEach(() => {
      accessToken = accessTokens.mint(authToken);
    });

    describe("when there is no access-token", () => {
      it("should return a 401", async () => {
        const res = await request(server).get(`/stream/track/${trackId}`);

        expect(res.status).toEqual(401);
      });
    });

    describe("when the access-token has expired", () => {
      it("should return a 401", async () => {
        now = now.add(1, "day");

        const res = await request(server)
          .get(`/stream/track/${trackId}`)
          .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);

        expect(res.status).toEqual(401);
      });
    });

    describe("scrobbling", () => {
      describe("when scrobbling succeeds", () => {
        it("should scrobble the track", async () => {
          const stream = {
            status: 200,
            headers: {
              "content-type": "audio/mp3",
            },
            data: Buffer.from("some track", "ascii"),
          };
  
          musicService.login.mockResolvedValue(musicLibrary);
          musicLibrary.stream.mockResolvedValue(stream);
          musicLibrary.scrobble.mockResolvedValue(true);
  
          const res = await request(server)
            .get(`/stream/track/${trackId}`)
            .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);
  
          expect(res.status).toEqual(stream.status);
          expect(musicLibrary.scrobble).toHaveBeenCalledWith(trackId);
        });
      });

      describe("when scrobbling succeeds", () => {
        it("should still return the track", async () => {
          const stream = {
            status: 200,
            headers: {
              "content-type": "audio/mp3",
            },
            data: Buffer.from("some track", "ascii"),
          };
  
          musicService.login.mockResolvedValue(musicLibrary);
          musicLibrary.stream.mockResolvedValue(stream);
          musicLibrary.scrobble.mockResolvedValue(false);
  
          const res = await request(server)
            .get(`/stream/track/${trackId}`)
            .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);
  
          expect(res.status).toEqual(stream.status);
          expect(musicLibrary.scrobble).toHaveBeenCalledWith(trackId);
        });
      });
    });

    describe("when sonos does not ask for a range", () => {
      describe("when the music service does not return a content-range, content-length or accept-ranges", () => {
        it("should return a 200 with the data, without adding the undefined headers", async () => {
          const stream = {
            status: 200,
            headers: {
              "content-type": "audio/mp3",
            },
            data: Buffer.from("some track", "ascii"),
          };

          musicService.login.mockResolvedValue(musicLibrary);
          musicLibrary.stream.mockResolvedValue(stream);
          musicLibrary.scrobble.mockResolvedValue(true);

          const res = await request(server)
            .get(`/stream/track/${trackId}`)
            .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);

          expect(res.status).toEqual(stream.status);
          expect(res.headers["content-type"]).toEqual("audio/mp3")
          expect(res.headers["content-length"]).toEqual(`${stream.data.length}`)
          expect(Object.keys(res.headers)).not.toContain("content-range")
          expect(Object.keys(res.headers)).not.toContain("accept-ranges")
        });
      });

      describe("when the music service returns undefined values for content-range, content-length or accept-ranges", () => {
        it("should return a 200 with the data, without adding the undefined headers", async () => {
          const stream = {
            status: 200,
            headers: {
              "content-type": "audio/mp3",
              "content-length": undefined,
              "accept-ranges": undefined,
              "content-range": undefined,
            },
            data: Buffer.from("some track", "ascii"),
          };

          musicService.login.mockResolvedValue(musicLibrary);
          musicLibrary.stream.mockResolvedValue(stream);
          musicLibrary.scrobble.mockResolvedValue(true);

          const res = await request(server)
            .get(`/stream/track/${trackId}`)
            .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);

            expect(res.status).toEqual(stream.status);
            expect(res.headers["content-type"]).toEqual("audio/mp3")
            expect(res.headers["content-length"]).toEqual(`${stream.data.length}`)
            expect(Object.keys(res.headers)).not.toContain("content-range")
            expect(Object.keys(res.headers)).not.toContain("accept-ranges")
          });
      });

      describe("when the music service returns a 200", () => {
        it("should return a 200 with the data", async () => {
          const stream = {
            status: 200,
            headers: {
              "content-type": "audio/mp3",
              "content-length": "222",
              "accept-ranges": "bytes",
              "content-range": "-100",
            },
            data: Buffer.from("some track", "ascii"),
          };

          musicService.login.mockResolvedValue(musicLibrary);
          musicLibrary.stream.mockResolvedValue(stream);
          musicLibrary.scrobble.mockResolvedValue(true);

          const res = await request(server)
            .get(`/stream/track/${trackId}`)
            .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);

          expect(res.status).toEqual(stream.status);
          expect(res.header["content-type"]).toEqual(
            stream.headers["content-type"]
          );
          expect(res.header["accept-ranges"]).toEqual(
            stream.headers["accept-ranges"]
          );
          expect(res.header["content-range"]).toEqual(
            stream.headers["content-range"]
          );

          expect(musicService.login).toHaveBeenCalledWith(authToken);
          expect(musicLibrary.stream).toHaveBeenCalledWith({ trackId });
        });
      });

      describe("when the music service returns a 206", () => {
        it("should return a 206 with the data", async () => {
          const stream = {
            status: 206,
            headers: {
              "content-type": "audio/ogg",
              "content-length": "333",
              "accept-ranges": "bytez",
              "content-range": "100-200",
            },
            data: Buffer.from("some other track", "ascii"),
          };

          musicService.login.mockResolvedValue(musicLibrary);
          musicLibrary.stream.mockResolvedValue(stream);
          musicLibrary.scrobble.mockResolvedValue(true);

          const res = await request(server)
            .get(`/stream/track/${trackId}`)
            .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);

          expect(res.status).toEqual(stream.status);
          expect(res.header["content-type"]).toEqual(
            stream.headers["content-type"]
          );
          expect(res.header["accept-ranges"]).toEqual(
            stream.headers["accept-ranges"]
          );
          expect(res.header["content-range"]).toEqual(
            stream.headers["content-range"]
          );

          expect(musicService.login).toHaveBeenCalledWith(authToken);
          expect(musicLibrary.stream).toHaveBeenCalledWith({ trackId });
        });
      });
    });

    describe("when sonos does ask for a range", () => {
      describe("when the music service returns a 200", () => {
        it("should return a 200 with the data", async () => {
          const stream = {
            status: 200,
            headers: {
              "content-type": "audio/mp3",
              "content-length": "222",
              "accept-ranges": "bytes",
              "content-range": "-100",
            },
            data: Buffer.from("some track", "ascii"),
          };

          musicService.login.mockResolvedValue(musicLibrary);
          musicLibrary.stream.mockResolvedValue(stream);
          musicLibrary.scrobble.mockResolvedValue(true);

          const res = await request(server)
            .get(`/stream/track/${trackId}`)
            .set(BONOB_ACCESS_TOKEN_HEADER, accessToken)
            .set("Range", "3000-4000");

          expect(res.status).toEqual(stream.status);
          expect(res.header["content-type"]).toEqual(
            stream.headers["content-type"]
          );
          expect(res.header["accept-ranges"]).toEqual(
            stream.headers["accept-ranges"]
          );
          expect(res.header["content-range"]).toEqual(
            stream.headers["content-range"]
          );

          expect(musicService.login).toHaveBeenCalledWith(authToken);
          expect(musicLibrary.stream).toHaveBeenCalledWith({
            trackId,
            range: "3000-4000",
          });
        });
      });

      describe("when the music service returns a 206", () => {
        it("should return a 206 with the data", async () => {
          const stream = {
            status: 206,
            headers: {
              "content-type": "audio/ogg",
              "content-length": "333",
              "accept-ranges": "bytez",
              "content-range": "100-200",
            },
            data: Buffer.from("some other track", "ascii"),
          };

          musicService.login.mockResolvedValue(musicLibrary);
          musicLibrary.stream.mockResolvedValue(stream);
          musicLibrary.scrobble.mockResolvedValue(true);

          const res = await request(server)
            .get(`/stream/track/${trackId}`)
            .set(BONOB_ACCESS_TOKEN_HEADER, accessToken)
            .set("Range", "4000-5000");

          expect(res.status).toEqual(stream.status);
          expect(res.header["content-type"]).toEqual(
            stream.headers["content-type"]
          );
          expect(res.header["accept-ranges"]).toEqual(
            stream.headers["accept-ranges"]
          );
          expect(res.header["content-range"]).toEqual(
            stream.headers["content-range"]
          );

          expect(musicService.login).toHaveBeenCalledWith(authToken);
          expect(musicLibrary.stream).toHaveBeenCalledWith({
            trackId,
            range: "4000-5000",
          });
        });
      });
    });
  });

  describe("art", () => {
    const musicService = {
      login: jest.fn(),
    };
    const musicLibrary = {
      coverArt: jest.fn(),
    };
    let now = dayjs();
    const accessTokens = new ExpiringAccessTokens({ now: () => now });

    const server = makeServer(
      (jest.fn() as unknown) as Sonos,
      aService(),
      "http://localhost:1234",
      (musicService as unknown) as MusicService,
      new InMemoryLinkCodes(),
      accessTokens
    );

    const authToken = uuid();
    const albumId = uuid();
    let accessToken: string;

    beforeEach(() => {
      accessToken = accessTokens.mint(authToken);
    });

    describe("when there is no access-token", () => {
      it("should return a 401", async () => {
        const res = await request(server).get(`/album/123/art/size/180`);

        expect(res.status).toEqual(401);
      });
    });

    describe("when the access-token has expired", () => {
      it("should return a 401", async () => {
        now = now.add(1, "day");

        const res = await request(server).get(
          `/album/123/art/size/180?${BONOB_ACCESS_TOKEN_HEADER}=${accessToken}`
        );

        expect(res.status).toEqual(401);
      });
    });

    describe("when there is a valid access token", () => {
      describe("some invalid art type", () => {
        it("should return a 400", async () => {
          const res = await request(server)
            .get(
              `/foo/${albumId}/art/size/180?${BONOB_ACCESS_TOKEN_HEADER}=${accessToken}`
            )
            .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);

          expect(res.status).toEqual(400);
        });
      });

      describe("artist art", () => {
        describe("when there is some", () => {
          it("should return the image and a 200", async () => {
            const coverArt = {
              status: 200,
              contentType: "image/jpeg",
              data: Buffer.from("some image", "ascii"),
            };
  
            musicService.login.mockResolvedValue(musicLibrary);
  
            musicLibrary.coverArt.mockResolvedValue(coverArt);
  
            const res = await request(server)
              .get(
                `/artist/${albumId}/art/size/180?${BONOB_ACCESS_TOKEN_HEADER}=${accessToken}`
              )
              .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);
  
            expect(res.status).toEqual(coverArt.status);
            expect(res.header["content-type"]).toEqual(coverArt.contentType);
  
            expect(musicService.login).toHaveBeenCalledWith(authToken);
            expect(musicLibrary.coverArt).toHaveBeenCalledWith(albumId, "artist", 180);
          });
        });

        describe("when there isn't one", () => {
          it("should return a 404", async () => {
            musicService.login.mockResolvedValue(musicLibrary);
  
            musicLibrary.coverArt.mockResolvedValue(undefined);
  
            const res = await request(server)
              .get(
                `/artist/${albumId}/art/size/180?${BONOB_ACCESS_TOKEN_HEADER}=${accessToken}`
              )
              .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);
  
            expect(res.status).toEqual(404);
          });
        });   
        
        describe("when there is an error", () => {
          it("should return a 500", async () => {
            musicService.login.mockResolvedValue(musicLibrary);
  
            musicLibrary.coverArt.mockRejectedValue("Boom")
  
            const res = await request(server)
              .get(
                `/artist/${albumId}/art/size/180?${BONOB_ACCESS_TOKEN_HEADER}=${accessToken}`
              )
              .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);
  
            expect(res.status).toEqual(500);
          });
        });         
      });
  
      describe("album art", () => {
        describe("when there is some", () => {
          it("should return the image and a 200", async () => {
            const coverArt = {
              status: 200,
              contentType: "image/jpeg",
              data: Buffer.from("some image", "ascii"),
            };
  
            musicService.login.mockResolvedValue(musicLibrary);
            musicLibrary.coverArt.mockResolvedValue(coverArt);
  
            const res = await request(server)
              .get(
                `/album/${albumId}/art/size/180?${BONOB_ACCESS_TOKEN_HEADER}=${accessToken}`
              )
              .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);
  
            expect(res.status).toEqual(coverArt.status);
            expect(res.header["content-type"]).toEqual(coverArt.contentType);
  
            expect(musicService.login).toHaveBeenCalledWith(authToken);
            expect(musicLibrary.coverArt).toHaveBeenCalledWith(albumId, "album", 180);
          });
        });

        describe("when there isnt any", () => {
          it("should return a 404", async () => {
            musicService.login.mockResolvedValue(musicLibrary);
            musicLibrary.coverArt.mockResolvedValue(undefined);
  
            const res = await request(server)
              .get(
                `/album/${albumId}/art/size/180?${BONOB_ACCESS_TOKEN_HEADER}=${accessToken}`
              )
              .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);
  
            expect(res.status).toEqual(404);
          });
        });

        describe("when there is an error", () => {
          it("should return a 500", async () => {
            musicService.login.mockResolvedValue(musicLibrary);
            musicLibrary.coverArt.mockRejectedValue("Boooooom")
  
            const res = await request(server)
              .get(
                `/album/${albumId}/art/size/180?${BONOB_ACCESS_TOKEN_HEADER}=${accessToken}`
              )
              .set(BONOB_ACCESS_TOKEN_HEADER, accessToken);
  
            expect(res.status).toEqual(500);
          });
        });
      });
    });
  });
 
});

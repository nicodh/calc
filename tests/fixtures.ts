import type { Payload } from "./host";

// Recorded from this build: a peer's empty workbook, published the way the
// first device in a chat publishes it, and the diff for the B2 = 42 that peer
// typed afterwards. To re-record, create a `Model` with the session below,
// take `toBytes()`, drop the creation commits with `flushSendQueue()`, set B2
// and flush again.
//
// The two belong together: a diff alone cannot bootstrap a device that has
// never seen the workbook it was written in.
export const SENDER = "6088ce72-5c43-419d-9e60-2605d477d46a";

export const SNAPSHOT: Payload = {
  kind: "snapshot",
  sender: SENDER,
  createdAt: 1792823820914,
  session: 3735928559,
  data: "AQAAAQJBMQAABlNoZWV0MQAABAEAAgAABAAEAAEAAAMKAQMKAQAAAAAAAAAAAAAAAAAAAQAAAAAEDAIFSW50ZXIEAgACCAEAAAAAAAAAAQQABAAEAAQAAQEBAQEBAQQABAAEAAQABAAAAAAAAAAAAAEGbm9ybWFsBAAEAAAJV29ya2Jvb2sxA1VUQwJlbg9Jcm9uQ2FsYyBTaGVldHMHMTAuMDAwMA1Jcm9uQ2FsYyBVc2VyDUlyb25DYWxjIFVzZXIAAAAGT2ZmaWNlByMwMDAwMDAHI0ZGRkZGRgcjNDQ1NDZBByNFN0U2RTYHIzQ0NzJDNAcjRUQ3RDMxByNBNUE1QTUHI0ZGQzAwMAcjNUI5QkQ1ByM3MEFENDcHIzA1NjNDMQcjOTU0RjcyAQQBAAEAcoKgbKEBAO++rd4BBAEAAQBygqBsoQEA776t3gcAAAAC3q2+7wEEAQABAHKCoGyhAQDvvq3eBlNoZWV0MQAAAAA=",
};

export const B2_DIFF: Payload = {
  sender: SENDER,
  data: "AQDvvq3eAAEAfYKgbKEBAwIGAAQBBwSQAAAHBJAAAAEAAAAAAAAAAEVAAAQBAgcHBEgAAAQABAECBwcESAAABAA=",
};

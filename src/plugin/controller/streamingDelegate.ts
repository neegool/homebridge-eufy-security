/* eslint-disable max-len */
/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-stream.ts: Homebridge camera streaming delegate implementation for Protect.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code. Thank you for your contributions to the HomeKit world.
 */
import {
  API, AudioRecordingCodecType, AudioRecordingSamplerate, AudioStreamingCodecType, AudioStreamingSamplerate, CameraController,
  CameraControllerOptions, CameraStreamingDelegate, H264Level, H264Profile, HAP, MediaContainerType, PrepareStreamCallback, PrepareStreamRequest, PrepareStreamResponse,
  SRTPCryptoSuites, SnapshotRequest, SnapshotRequestCallback, StartStreamRequest, StreamRequestCallback, StreamRequestTypes, StreamingRequest,
} from 'homebridge';
import {
  PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_HKSV_SEGMENT_LENGTH, PROTECT_HKSV_TIMESHIFT_BUFFER_MAXLENGTH, PROTECT_HOMEKIT_IDR_INTERVAL,
  PROTECT_SNAPSHOT_CACHE_MAXAGE,
} from '../settings.js';
import { CameraAccessory, RtspEntry } from '../accessories/CameraAccessory.js';
import { FfmpegOptions } from '../utils/ffmpeg-options.js';
import { FfmpegStreamingProcess } from '../utils/ffmpeg-stream.js';
import { Logger as TsLogger, ILogObj } from 'tslog';
import { EufySecurityPlatform } from '../platform.js';
import WebSocket from 'ws';
import { once } from 'node:events';
import { RtpDemuxer } from '../utils/rtp.js';
import { ProtectRecordingDelegate } from './recordingDelegate.js';
import { readFileSync } from 'node:fs';

const SnapshotBlack = readFileSync(require.resolve('../../media/Snapshot-black.png'));
const SnapshotUnavailable = readFileSync(require.resolve('../../media/Snapshot-Unavailable.png'));

type SessionInfo = {
  address: string; // Address of the HomeKit client.
  addressVersion: string;

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites; // This should be saved if multiple suites are supported.
  videoSRTP: Buffer; // Key and salt concatenated.
  videoSSRC: number; // RTP synchronisation source.

  hasAudioSupport: boolean; // Does the user have a version of FFmpeg that supports AAC-ELD?
  audioPort: number;
  audioIncomingRtcpPort: number;
  audioIncomingRtpPort: number; // Port to receive audio from the HomeKit microphone.
  rtpDemuxer: RtpDemuxer | null; // RTP demuxer needed for two-way audio.
  rtpPortReservations: number[]; // RTP port reservations.
  talkBack: string | null; // Talkback websocket needed for two-way audio.
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
};

// Camera streaming delegate implementation for Protect.
export class ProtectStreamingDelegate implements CameraStreamingDelegate {

  private readonly api: API;
  public controller: CameraController;
  public readonly ffmpegOptions: FfmpegOptions;
  private readonly hap: HAP;
  public hksv: ProtectRecordingDelegate | null;
  public readonly log: TsLogger<ILogObj>;
  private ongoingSessions: { [index: string]: { ffmpeg: FfmpegStreamingProcess[]; rtpDemuxer: RtpDemuxer | null; rtpPortReservations: number[] } };
  private pendingSessions: { [index: string]: SessionInfo };
  public readonly platform: EufySecurityPlatform;
  public readonly protectCamera: CameraAccessory;
  private probesizeOverride: number;
  private probesizeOverrideCount: number;
  private probesizeOverrideTimeout?: NodeJS.Timeout;
  private rtspEntry: RtspEntry | null;
  private savedBitrate: number;
  private snapshotCache: { [index: string]: { image: Buffer; time: number } };
  public verboseFfmpeg: boolean;

  // Create an instance of a HomeKit streaming delegate.
  constructor(protectCamera: CameraAccessory, resolutions: [number, number, number][]) {

    this.api = protectCamera.platform.api;
    this.hap = protectCamera.platform.api.hap;
    this.hksv = null;
    this.log = protectCamera.log;
    this.ongoingSessions = {};
    this.protectCamera = protectCamera;
    this.pendingSessions = {};
    this.platform = protectCamera.platform;
    this.probesizeOverride = 0;
    this.probesizeOverrideCount = 0;
    this.rtspEntry = null;
    this.savedBitrate = 0;
    this.snapshotCache = {};
    this.verboseFfmpeg = false;

    // Configure our hardware acceleration support.
    this.ffmpegOptions = new FfmpegOptions(protectCamera);

    // Setup for HKSV, if enabled.
    if (this.protectCamera.hasHksv) {

      this.hksv = new ProtectRecordingDelegate(protectCamera);
    }

    // Setup for our camera controller.
    const options: CameraControllerOptions = {

      // HomeKit requires at least 2 streams, and HomeKit Secure Video requires 1.
      cameraStreamCount: 10,

      // Our streaming delegate - aka us.
      delegate: this,

      // Our recording capabilities for HomeKit Secure Video.
      recording: !this.protectCamera.hasHksv ? undefined : {

        delegate: this.hksv as ProtectRecordingDelegate,

        options: {

          audio: {

            codecs: [
              {

                // Protect supports a 48 KHz sampling rate, and the low complexity AAC profile.
                samplerate: AudioRecordingSamplerate.KHZ_48,
                type: AudioRecordingCodecType.AAC_LC,
              },
            ],
          },

          mediaContainerConfiguration: [
            {

              // The default HKSV segment length is 4000ms. It turns out that any setting less than that will disable
              // HomeKit Secure Video.
              fragmentLength: PROTECT_HKSV_SEGMENT_LENGTH,
              type: MediaContainerType.FRAGMENTED_MP4,
            },
          ],

          // Maximum prebuffer length supported. In Protect, this is effectively unlimited, but HomeKit only seems to
          // request a maximum of a 4000ms prebuffer.
          prebufferLength: PROTECT_HKSV_TIMESHIFT_BUFFER_MAXLENGTH,

          video: {

            parameters: {

              // Through admittedly anecdotal testing on various G3 and G4 models, UniFi Protect seems to support
              // only the H.264 Main profile, though it does support various H.264 levels, ranging from Level 3
              // through Level 5.1 (G4 Pro at maximum resolution). However, HomeKit only supports Level 3.1, 3.2,
              // and 4.0 currently.
              levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
              profiles: [H264Profile.MAIN],
            },

            resolutions: resolutions,

            type: this.api.hap.VideoCodecType.H264,
          },
        },
      },

      // Our motion sensor.
      sensors: !this.protectCamera.hasHksv ? undefined : {

        motion: this.protectCamera.accessory.getService(this.hap.Service.MotionSensor),
      },

      streamingOptions: {

        audio: {

          codecs: [

            {
              audioChannels: 1,
              bitrate: 0,
              samplerate: [AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24],
              type: AudioStreamingCodecType.AAC_ELD,
            },
          ],

          twoWayAudio: this.protectCamera.hints.twoWayAudio,
        },

        supportedCryptoSuites: [this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],

        video: {

          codec: {
            // Through admittedly anecdotal testing on various G3 and G4 models, UniFi Protect seems to support
            // only the H.264 Main profile, though it does support various H.264 levels, ranging from Level 3
            // through Level 5.1 (G4 Pro at maximum resolution). However, HomeKit only supports Level 3.1, 3.2,
            // and 4.0 currently.
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
            profiles: [H264Profile.MAIN],
          },

          // Retrieve the list of supported resolutions from the camera and apply our best guesses for how to
          // map specific resolutions to the available RTSP streams on a camera. Unfortunately, this creates
          // challenges in doing on-the-fly RTSP changes in UniFi Protect. Once the list of supported
          // resolutions is set here, there's no going back unless a user reboots. Homebridge doesn't have a way
          // to dynamically adjust the list of supported resolutions at this time.
          resolutions: resolutions,
        },
      },
    };

    this.controller = new this.hap.CameraController(options);
  }

  // HomeKit image snapshot request handler.
  public async handleSnapshotRequest(request?: SnapshotRequest, callback?: SnapshotRequestCallback): Promise<void> {

    const snapshot = await this.getSnapshot(request);

    // No snapshot was returned - we're done here.
    if (!snapshot) {

      if (callback) {

        callback(new Error(this.protectCamera.name + ': Unable to retrieve a snapshot'));
      }

      return;
    }

    // Return the image to HomeKit.
    if (callback) {

      callback(undefined, snapshot);
    }

    // Publish the snapshot as a data URL to MQTT, if configured.
    // this.nvr.mqtt?.publish(this.protectCamera.accessory, 'snapshot', 'data:image/jpeg;base64,' + snapshot.toString('base64'));
  }

  // Prepare to launch the video stream.
  public async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {

    let reservePortFailed = false;
    const rtpPortReservations: number[] = [];

    // We use this utility to identify errors in reserving UDP ports for our use.
    const reservePort = async (ipFamily: ('ipv4' | 'ipv6') = 'ipv4', portCount: (1 | 2) = 1): Promise<number> => {

      // If we've already failed, don't keep trying to find more ports.
      if (reservePortFailed) {

        return -1;
      }

      // Retrieve the ports we're looking for.
      const assignedPort = await this.platform.rtpPorts.reservePort(ipFamily, portCount);

      // We didn't get the ports we requested.
      if (assignedPort === -1) {

        reservePortFailed = true;
      } else {

        // Add this reservation the list of ports we've successfully requested.
        rtpPortReservations.push(assignedPort);

        if (portCount === 2) {

          rtpPortReservations.push(assignedPort + 1);
        }
      }

      // Return them.
      return assignedPort;
    };

    // Check if the camera has a microphone and if we have audio support is enabled in the plugin.
    const isAudioEnabled = true;

    // We need to check for AAC support because it's going to determine whether we support audio.
    const hasAudioSupport = isAudioEnabled && (this.ffmpegOptions.audioEncoder.length > 0);

    // Setup our audio plumbing.
    const audioIncomingRtcpPort = (await reservePort(request.addressVersion));
    const audioIncomingPort = (hasAudioSupport && this.protectCamera.hints.twoWayAudio) ? (await reservePort(request.addressVersion)) : -1;
    const audioIncomingRtpPort = (hasAudioSupport && this.protectCamera.hints.twoWayAudio) ? (await reservePort(request.addressVersion, 2)) : -1;

    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    if (!hasAudioSupport) {

      this.log.info('Audio support disabled.%s', isAudioEnabled ? ' A version of FFmpeg that is compiled with fdk_aac support is required to support audio.' : '');
    }

    let rtpDemuxer: RtpDemuxer | null = null;
    const talkBack = null;

    if (hasAudioSupport && this.protectCamera.hints.twoWayAudio) {

      // Setup the RTP demuxer for two-way audio scenarios.
      rtpDemuxer = new RtpDemuxer(this, request.addressVersion, audioIncomingPort, audioIncomingRtcpPort, audioIncomingRtpPort);

      // Request the talkback websocket from the controller.
      // const params = new URLSearchParams({ camera: this.protectCamera.ufp.id });
      // talkBack = await this.nvr.ufpApi.getWsEndpoint('talkback', params);

      // Something went wrong and we don't have a talkback websocket.
      if (!talkBack) {

        this.log.error('Unable to open the return audio channel.');
      }
    }

    // Setup our video plumbing.
    const videoReturnPort = (await reservePort(request.addressVersion));
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();

    // If we've had failures to retrieve the UDP ports we're looking for, inform the user.
    if (reservePortFailed) {

      this.log.error('Unable to reserve the UDP ports needed to begin streaming.');
    }

    const sessionInfo: SessionInfo = {

      address: request.targetAddress,
      addressVersion: request.addressVersion,

      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioIncomingRtcpPort: audioIncomingRtcpPort,
      audioIncomingRtpPort: audioIncomingRtpPort,
      audioPort: request.audio.port,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: audioSSRC,

      hasAudioSupport: hasAudioSupport,
      rtpDemuxer: rtpDemuxer,
      rtpPortReservations: rtpPortReservations,
      talkBack: talkBack,

      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoPort: request.video.port,
      videoReturnPort: videoReturnPort,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: videoSSRC,
    };

    // Prepare the response stream. Here's where we figure out if we're doing two-way audio or not. For two-way audio,
    // we need to use a demuxer to separate RTP and RTCP packets. For traditional video/audio streaming, we want to keep
    // it simple and don't use a demuxer.
    const response: PrepareStreamResponse = {

      audio: {

        port: (hasAudioSupport && this.protectCamera.hints.twoWayAudio) ? audioIncomingPort : audioIncomingRtcpPort,
        // eslint-disable-next-line camelcase
        srtp_key: request.audio.srtp_key,
        // eslint-disable-next-line camelcase
        srtp_salt: request.audio.srtp_salt,
        ssrc: audioSSRC,
      },

      video: {

        port: videoReturnPort,
        // eslint-disable-next-line camelcase
        srtp_key: request.video.srtp_key,
        // eslint-disable-next-line camelcase
        srtp_salt: request.video.srtp_salt,
        ssrc: videoSSRC,
      },
    };

    // Add it to the pending session queue so we're ready to start when we're called upon.
    this.pendingSessions[request.sessionID] = sessionInfo;
    callback(undefined, response);
  }

  // Launch the Protect video (and audio) stream.
  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {

    const sessionInfo = this.pendingSessions[request.sessionID];
    const sdpIpVersion = sessionInfo.addressVersion === 'ipv6' ? 'IP6 ' : 'IP4';

    // If we aren't connected, we're done.
    if (!this.protectCamera.isOnline) {
      const errorMessage = 'Unable to start video stream: the camera is offline or unavailable.';

      this.log.error(errorMessage);
      callback(new Error(this.protectCamera.name + ': ' + errorMessage));
      return;
    }

    // Has the user explicitly configured transcoding, or are we a high latency session (e.g. cellular)? If we're high latency, we'll transcode
    // by default unless the user has asked us not to. Why? It generally results in a speedier experience, at the expense of some stream quality
    // (HomeKit tends to request far lower bitrates than Protect is capable of producing).
    //
    // How do we determine if we're a high latency connection? We look at the RTP packet time of the audio packet time for a hint. HomeKit uses values
    // of 20, 30, 40, and 60ms. We make an assumption, validated by lots of real-world testing, that when we see 60ms used by HomeKit, it's a
    // high latency connection and act accordingly.
    const isTranscoding = this.protectCamera.hints.transcode || ((request.audio.packet_time >= 60) && this.protectCamera.hints.transcodeHighLatency);

    // Find the best RTSP stream based on what we're looking for.
    this.rtspEntry = this.protectCamera.findRtsp(
      (isTranscoding && this.protectCamera.hints.hardwareTranscoding) ? 3840 : request.video.width,
      (isTranscoding && this.protectCamera.hints.hardwareTranscoding) ? 2160 : request.video.height,
      undefined,
      isTranscoding ? this.ffmpegOptions.hostSystemMaxPixels : 0,
    );

    if (!this.rtspEntry) {

      const errorMessage = 'Unable to start video stream: no valid RTSP stream profile was found.';

      this.log.error('%s %sx%s, %s fps, %s kbps.', errorMessage,
        request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate.toLocaleString('en-US'));

      callback(new Error(this.protectCamera.name + ': ' + errorMessage));
      return;
    }

    // Save our current bitrate before we modify it, but only if we're the first stream - we don't want to do this for
    // concurrent streaming clients for this camera.
    if (!this.savedBitrate) {

      this.savedBitrate = this.protectCamera.getBitrate(this.rtspEntry.channel.id);

      if (this.savedBitrate < 0) {

        this.savedBitrate = 0;
      }
    }

    // Set the desired bitrate in Protect. We don't need to for this to return, because Protect
    // will adapt the stream once it processes the configuration change.
    await this.protectCamera.setBitrate(this.rtspEntry.channel.id, request.video.max_bit_rate * 1000);

    // Set our packet size to be 564. Why? MPEG transport stream (TS) packets are 188 bytes in size each.
    // These packets transmit the video data that you ultimately see on your screen and are transmitted using
    // UDP. Each UDP packet is 1316 bytes in size, before being encapsulated in IP. We want to get as many
    // TS packets as we can, within reason, in those UDP packets. This translates to 1316 / 188 = 7 TS packets
    // as a limit of what can be pushed through a single UDP packet. Here's the problem...you need to have
    // enough data to fill that pipe, all the time. Network latency, FFmpeg overhead, and the speed / quality of
    // the original camera stream all play a role here, and as you can imagine, there's a nearly endless set of
    // combinations to decide how to best fill that pipe. Set it too low, and you're incurring extra overhead by
    // pushing less video data to clients in each packet, though you're increasing interactivity by getting
    // whatever data you have to the end user. Set it too high, and startup latency becomes unacceptable
    // when you begin a stream.
    //
    // For audio, you have a latency problem and a packet size that's too big will force the audio to sound choppy
    // - so we opt to increase responsiveness at the risk of more overhead. This gives the end user a much better
    // audio experience, at a marginal cost in bandwidth overhead.
    //
    // Through experimentation, I've found a sweet spot of 188 * 3 = 564 for video on Protect cameras. In my testing,
    // adjusting the packet size beyond 564 did not have a material impact in improving the startup time, and often had
    // a negative impact.
    const videomtu = 188 * 3;
    const audiomtu = 188 * 1;

    // -hide_banner                     Suppress printing the startup banner in FFmpeg.
    // -nostats                         Suppress printing progress reports while encoding in FFmpeg.
    // -fflags flags                    Set format flags to discard any corrupt packets rather than exit.
    // -probesize number                How many bytes should be analyzed for stream information.
    // -max_delay 500000                Set an upper limit on how much time FFmpeg can take in demuxing packets, in microseconds.
    // -r fps                           Set the input frame rate for the video stream.
    // -rtsp_transport tcp              Tell the RTSP stream handler that we're looking for a TCP connection.
    // -i this.rtspEntry.url            RTSPS URL to get our input stream from.
    // -map 0:v:0                       selects the first available video track from the stream. Protect actually maps audio
    //                                  and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                  setting is a more general solution than naming the track locations directly in case
    //                                  Protect changes this in the future.
    //
    //                                  Yes, we included these above as well: they need to be included for each I/O stream to maximize effectiveness it seems.
    const ffmpegArgs = [

      '-hide_banner',
      '-nostats',
      '-fflags', '+discardcorrupt',
      ...this.ffmpegOptions.videoDecoder,
      '-probesize', this.probesize.toString(),
      '-max_delay', '500000',
      '-r', this.rtspEntry.channel.fps.toString(),
      '-rtsp_transport', 'tcp',
      '-i', this.rtspEntry.url,
      '-map', '0:v:0',
    ];

    // Inform the user.
    this.log.info('Streaming request from %s%s: %sx%s@%sfps, %s kbps. %s %s, %s kbps.',
      sessionInfo.address, (request.audio.packet_time === 60) ? ' (high latency connection)' : '',
      request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate.toLocaleString('en-US'),
      isTranscoding ? (this.protectCamera.hints.hardwareTranscoding ? 'Hardware accelerated transcoding' : 'Transcoding') : 'Using',
      this.rtspEntry.name, (this.rtspEntry.channel.bitrate / 1000).toLocaleString('en-US'));

    // Check to see if we're transcoding. If we are, set the right FFmpeg encoder options. If not, copy the video stream.
    if (isTranscoding) {

      // Configure our video parameters for transcoding.
      ffmpegArgs.push(...this.ffmpegOptions.streamEncoder(request.video.width, request.video.height, this.rtspEntry.channel.fps, request.video.max_bit_rate,
        request.video.profile, request.video.level, PROTECT_HOMEKIT_IDR_INTERVAL, this.rtspEntry.channel.fps));
    } else {

      // Configure our video parameters for just copying the input stream from Protect - it tends to be quite solid in most cases:
      //
      // -vcodec copy        Copy the stream withour reencoding it.
      ffmpegArgs.push(

        '-vcodec', 'copy',
      );
    }

    // Add in any user-specified options for FFmpeg.
    // if (this.platform.config.ffmpegOptions) {

    //   ffmpegArgs.push(...this.platform.config.ffmpegOptions);
    // }

    // Configure our video parameters for SRTP streaming:
    //
    // -payload_type num                Payload type for the RTP stream. This is negotiated by HomeKit and is usually 99 for H.264 video.
    // -ssrc                            Synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
    // -f rtp                           Specify that we're using the RTP protocol.
    // -srtp_out_suite enc              Specify the output encryption encoding suites.
    // -srtp_out_params params          Specify the output encoding parameters. This is negotiated by HomeKit.
    ffmpegArgs.push(

      '-payload_type', request.video.pt.toString(),
      '-ssrc', sessionInfo.videoSSRC.toString(),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', sessionInfo.videoSRTP.toString('base64'),
      'srtp://' + sessionInfo.address + ':' + sessionInfo.videoPort.toString() + '?rtcpport=' + sessionInfo.videoPort.toString() +
      '&pkt_size=' + videomtu.toString(),
    );

    // Configure the audio portion of the command line, if we have a version of FFmpeg supports the audio codecs we need. Options we use are:
    //
    // -map 0:a:0?                      Selects the first available audio track from the stream, if it exists. Protect actually maps audio
    //                                  and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                  setting is a more general solution than naming the track locations directly in case
    //                                  Protect changes this in the future.
    // -acodec                          Encode using the codecs available to us on given platforms.
    // -profile:a 38                    Specify enhanced, low-delay AAC for HomeKit.
    // -flags +global_header            Sets the global header in the bitstream.
    // -f null                          Null filter to pass the audio unchanged without running through a muxing operation.
    // -ar samplerate                   Sample rate to use for this audio. This is specified by HomeKit.
    // -b:a bitrate                     Bitrate to use for this audio stream. This is specified by HomeKit.
    // -bufsize size                    This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -ac 1                            Set the number of audio channels to 1.
    if (sessionInfo.hasAudioSupport) {

      // Configure our audio parameters.
      ffmpegArgs.push(

        '-map', '0:a:0?',
        ...this.ffmpegOptions.audioEncoder,
        '-profile:a', '38',
        '-flags', '+global_header',
        '-f', 'null',
        '-ar', request.audio.sample_rate.toString() + 'k',
        '-b:a', request.audio.max_bit_rate.toString() + 'k',
        '-bufsize', (2 * request.audio.max_bit_rate).toString() + 'k',
        '-ac', request.audio.channel.toString(),
      );

      // If we are audio filtering, address it here.
      if (this.protectCamera.hasFeature('Audio.Filter.Noise')) {

        const afOptions: string[] = [];

        // See what the user has set for the afftdn filter for this camera.
        let fftNr = PROTECT_FFMPEG_AUDIO_FILTER_FFTNR;

        // If we have an invalid setting, use the defaults.
        if ((fftNr < 0.01) || (fftNr > 97)) {

          fftNr = (fftNr > 97) ? 97 : ((fftNr < 0.01) ? 0.01 : fftNr);
        }

        // The afftdn filter options we use are:
        //
        // nt=w  Focus on eliminating white noise.
        // om=o  Output the filtered audio.
        // tn=1  Enable noise tracking.
        // tr=1  Enable residual tracking.
        // nr=X  Noise reduction value in decibels.
        afOptions.push('afftdn=nt=w:om=o:tn=1:tr=1:nr=' + fftNr.toString());

        // const highpass = this.protectCamera.getFeatureNumber('Audio.Filter.Noise.HighPass');
        // const lowpass = this.protectCamera.getFeatureNumber('Audio.Filter.Noise.LowPass');

        // // Only set the highpass and lowpass filters if the user has explicitly enabled them.
        // if (highpass !== undefined) {

        //   afOptions.push('highpass=f=' + highpass.toString());
        // }

        // if (lowpass !== undefined) {

        //   afOptions.push('lowpass=f=' + lowpass.toString());
        // }

        // Return the assembled audio filter option.
        ffmpegArgs.push('-af', afOptions.join(', '));
      }

      // Add the required RTP settings and encryption for the stream:
      //
      // -payload_type num                Payload type for the RTP stream. This is negotiated by HomeKit and is usually 110 for AAC-ELD audio.
      // -ssrc                            synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
      // -f rtp                           Specify that we're using the RTP protocol.
      // -srtp_out_suite enc              Specify the output encryption encoding suites.
      // -srtp_out_params params          Specify the output encoding parameters. This is negotiated by HomeKit.
      ffmpegArgs.push(

        '-payload_type', request.audio.pt.toString(),
        '-ssrc', sessionInfo.audioSSRC.toString(),
        '-f', 'rtp',
        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params', sessionInfo.audioSRTP.toString('base64'),
        'srtp://' + sessionInfo.address + ':' + sessionInfo.audioPort.toString() + '?rtcpport=' + sessionInfo.audioPort.toString() +
        '&pkt_size=' + audiomtu.toString(),
      );
    }

    // Additional logging, but only if we're debugging.
    if (this.platform.verboseFfmpeg || this.verboseFfmpeg) {

      ffmpegArgs.push('-loglevel', 'level+verbose');
    }

    if (this.platform.config.enableDetailedLogging) {

      ffmpegArgs.push('-loglevel', 'level+debug');
    }

    // Combine everything and start an instance of FFmpeg.
    const ffmpegStream = new FfmpegStreamingProcess(this, request.sessionID, ffmpegArgs,
      (sessionInfo.hasAudioSupport && this.protectCamera.hints.twoWayAudio) ? undefined :
        { addressVersion: sessionInfo.addressVersion, port: sessionInfo.videoReturnPort },
      callback);

    // Some housekeeping for our FFmpeg and demuxer sessions.
    this.ongoingSessions[request.sessionID] = {

      ffmpeg: [ffmpegStream],
      rtpDemuxer: sessionInfo.rtpDemuxer,
      rtpPortReservations: sessionInfo.rtpPortReservations,
    };

    delete this.pendingSessions[request.sessionID];

    // If we aren't doing two-way audio, we're done here. For two-way audio...we have some more plumbing to do.
    if (!sessionInfo.hasAudioSupport || !this.protectCamera.hints.twoWayAudio) {

      return;
    }

    // Session description protocol message that FFmpeg will share with HomeKit.
    // SDP messages tell the other side of the connection what we're expecting to receive.
    //
    // Parameters are:
    //
    // v             Protocol version - always 0.
    // o             Originator and session identifier.
    // s             Session description.
    // c             Connection information.
    // t             Timestamps for the start and end of the session.
    // m             Media type - audio, adhering to RTP/AVP, payload type 110.
    // b             Bandwidth information - application specific, 16k or 24k.
    // a=rtpmap      Payload type 110 corresponds to an MP4 stream. Format is MPEG4-GENERIC/<audio clock rate>/<audio channels>
    // a=fmtp        For payload type 110, use these format parameters.
    // a=crypto      Crypto suite to use for this session.
    const sdpReturnAudio = [

      'v=0',
      'o=- 0 0 IN ' + sdpIpVersion + ' 127.0.0.1',
      's=' + this.protectCamera.name + ' Audio Talkback',
      'c=IN ' + sdpIpVersion + ' ' + sessionInfo.address,
      't=0 0',
      'm=audio ' + sessionInfo.audioIncomingRtpPort.toString() + ' RTP/AVP ' + request.audio.pt.toString(),
      'b=AS:24',
      'a=rtpmap:110 MPEG4-GENERIC/' + ((request.audio.sample_rate === AudioStreamingSamplerate.KHZ_16) ? '16000' : '24000') + '/' + request.audio.channel.toString(),
      'a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=' +
      ((request.audio.sample_rate === AudioStreamingSamplerate.KHZ_16) ? 'F8F0212C00BC00' : 'F8EC212C00BC00'),
      'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' + sessionInfo.audioSRTP.toString('base64'),
    ].join('\n');

    // Configure the audio portion of the command line, if we have a version of FFmpeg supports the audio codecs we need. Options we use are:
    //
    // -hide_banner           Suppress printing the startup banner in FFmpeg.
    // -nostats               Suppress printing progress reports while encoding in FFmpeg.
    // -protocol_whitelist    Set the list of allowed protocols for this FFmpeg session.
    // -f sdp                 Specify that our input will be an SDP file.
    // -acodec                Decode AAC input using the specified decoder.
    // -i pipe:0              Read input from standard input.
    // -acodec                Encode to AAC. This format is set by Protect.
    // -flags +global_header  Sets the global header in the bitstream.
    // -ar                    Sets the audio rate to what Protect is expecting.
    // -b:a                   Bitrate to use for this audio stream based on what HomeKit is providing us.
    // -ac                    Sets the channel layout of the audio stream based on what Protect is expecting.
    // -f adts                Transmit an ADTS stream.
    // pipe:1                 Output the ADTS stream to standard output.
    const ffmpegReturnAudioCmd = [

      '-hide_banner',
      '-nostats',
      '-protocol_whitelist', 'crypto,file,pipe,rtp,udp',
      '-f', 'sdp',
      '-acodec', this.ffmpegOptions.audioDecoder,
      '-i', 'pipe:0',
      '-map', '0:a:0',
      ...this.ffmpegOptions.audioEncoder,
      '-flags', '+global_header',
      // '-ar', this.protectCamera.ufp.talkbackSettings.samplingRate.toString(),
      '-b:a', request.audio.max_bit_rate.toString() + 'k',
      // '-ac', this.protectCamera.ufp.talkbackSettings.channels.toString(),
      '-f', 'adts',
      'pipe:1',
    ];

    // Additional logging, but only if we're debugging.
    if (this.platform.verboseFfmpeg || this.verboseFfmpeg) {

      ffmpegReturnAudioCmd.push('-loglevel', 'level+verbose');
    }

    if (this.platform.config.enableDetailedLogging) {

      ffmpegReturnAudioCmd.push('-loglevel', 'level+debug');
    }

    try {

      // Now it's time to talkback.
      let ws: WebSocket | null = null;
      let isTalkbackLive = false;
      let dataListener: (data: Buffer) => void;
      let openListener: () => void;

      if (sessionInfo.talkBack) {

        // Open the talkback connection.
        ws = new WebSocket(sessionInfo.talkBack, { rejectUnauthorized: false });
        isTalkbackLive = true;

        // Catch any errors and inform the user, if needed.
        ws?.once('error', (error) => {

          // Ignore timeout errors, but notify the user about anything else.
          if ((error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {

            this.log.error('Error in communicating with the return audio channel: %s', error);
          }

          ws?.terminate();
        });

        // Catch any stray open events after we've closed.
        ws?.on('open', openListener = (): void => {

          // If we've somehow opened after we've wrapped up talkback, terminate the connection.
          if (!isTalkbackLive) {

            ws?.terminate();
          }
        });

        // Cleanup after ourselves on close.
        ws?.once('close', () => {

          ws?.removeListener('open', openListener);
        });
      }

      // Wait for the first RTP packet to be received before trying to launch FFmpeg.
      if (sessionInfo.rtpDemuxer) {

        await once(sessionInfo.rtpDemuxer, 'rtp');

        // If we've already closed the RTP demuxer, we're done here,
        if (!sessionInfo.rtpDemuxer.isRunning) {

          // Clean up our talkback websocket.
          ws?.terminate();
          return;
        }
      }

      // Fire up FFmpeg and start processing the incoming audio.
      const ffmpegReturnAudio = new FfmpegStreamingProcess(this, request.sessionID, ffmpegReturnAudioCmd);

      // Setup housekeeping for the twoway FFmpeg session.
      this.ongoingSessions[request.sessionID].ffmpeg.push(ffmpegReturnAudio);

      // Feed the SDP session description to FFmpeg on stdin.
      ffmpegReturnAudio.stdin?.end(sdpReturnAudio + '\n');

      // Send the audio.
      ffmpegReturnAudio.stdout?.on('data', dataListener = (data: Buffer): void => {

        ws?.send(data, (error: Error | undefined): void => {

          // This happens when an error condition is encountered on sending data to the websocket.
          // We assume the worst and close our talkback channel.
          if (error) {

            ws?.terminate();
          }
        });
      });

      // Make sure we terminate the talkback websocket when we're done.
      ffmpegReturnAudio.ffmpegProcess?.once('exit', () => {

        // Make sure we catch any stray connections that may be too slow to open.
        isTalkbackLive = false;

        // Close the websocket.
        if ((ws?.readyState === WebSocket.CLOSING) || (ws?.readyState === WebSocket.OPEN)) {

          ws?.terminate();
        }

        ffmpegReturnAudio.stdout?.removeListener('data', dataListener);
      });
    } catch (error) {

      this.log.error('Unable to connect to the return audio channel: %s', error);
    }
  }

  // Process incoming stream requests.
  public async handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): Promise<void> {

    switch (request.type) {

      case StreamRequestTypes.START:

        await this.startStream(request, callback);
        break;

      case StreamRequestTypes.RECONFIGURE:

        // Once FFmpeg is updated to support this, we'll enable this one.
        this.log.info('Streaming parameters adjustment requested by HomeKit: %sx%s, %s fps, %s kbps.',
          request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate.toLocaleString('en-US'));

        // Set the desired bitrate in Protect.
        if (this.rtspEntry) {

          await this.protectCamera.setBitrate(this.rtspEntry.channel.id, request.video.max_bit_rate * 1000);
        }

        callback();
        break;

      case StreamRequestTypes.STOP:
      default:

        await this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  // Retrieve a cached snapshot, if available.
  private getCachedSnapshot(cameraMac: string): Buffer | null {

    // If we have an image from the last few seconds, we can use it. Otherwise, we're done.
    if (!this.snapshotCache[cameraMac] || ((Date.now() - this.snapshotCache[cameraMac].time) > (PROTECT_SNAPSHOT_CACHE_MAXAGE * 1000))) {

      delete this.snapshotCache[cameraMac];
      return null;
    }

    return this.snapshotCache[cameraMac].image;
  }

  // Take a snapshot.
  public async getSnapshot(request?: SnapshotRequest, isLoggingErrors = true): Promise<Buffer | null> {

    const logError = (message: string, ...parameters: unknown[]): void => {

      // We don't need to log errors for snapshot cache refreshes.
      if (isLoggingErrors) {

        this.log.error(message, ...parameters);
      }
    };

    // If we aren't connected, we're done.
    if (!this.protectCamera.isOnline) {

      logError('Unable to retrieve a snapshot: the camera is offline or unavailable.');
      return null;
    }

    // Don't log the inevitable API errors related to response delays from the Protect controller.
    // const savedLogState = this.nvr.logApiErrors;

    // if (!isLoggingErrors) {

    //   this.nvr.logApiErrors = false;
    // }

    // // Request the image from the controller. If we've specified a specific dimension, we pass that along in our snapshot request.
    // const snapshot = await this.nvr.ufpApi.getSnapshot(this.protectCamera.ufp, request ? request.width : undefined, request ? request.height : undefined,
    //   undefined, 'packageCamera' in this.protectCamera.accessory.context);

    // if (!isLoggingErrors) {

    //   this.nvr.logApiErrors = savedLogState;
    // }

    // Occasional snapshot failures will happen. The controller isn't always able to generate them if it's already generating one,
    // or it's requested too quickly after the last one.
    // if (!snapshot) {

    //   // See if we have an image cached that we can use instead.
    //   const cachedSnapshot = this.getCachedSnapshot(this.protectCamera.ufp.mac);

    //   if (cachedSnapshot) {

    //     logError('Unable to retrieve a snapshot. Using the most recent cached snapshot instead.');
    //     return cachedSnapshot;
    //   }

    //   logError('Unable to retrieve a snapshot.');

    //   return null;
    // }

    // Cache the image before returning it.
    // this.snapshotCache[this.protectCamera.ufp.mac] = { image: snapshot, time: Date.now() };
    return SnapshotUnavailable;
  }

  // Close a video stream.
  public async stopStream(sessionId: string): Promise<void> {

    try {

      // Stop any FFmpeg instances we have running.
      if (this.ongoingSessions[sessionId]) {

        for (const ffmpegProcess of this.ongoingSessions[sessionId].ffmpeg) {
          ffmpegProcess.stop();
        }

        // Close the demuxer, if we have one.
        this.ongoingSessions[sessionId].rtpDemuxer?.close();

        // Inform the user.
        this.log.info('Stopped video streaming session.');

        // Release our port reservations.
        this.ongoingSessions[sessionId].rtpPortReservations.map(x => this.platform.rtpPorts.freePort(x));
      }

      // On the off chance we were signaled to prepare to start streaming, but never actually started streaming, cleanup after ourselves.
      if (this.pendingSessions[sessionId]) {

        // Release our port reservations.
        this.pendingSessions[sessionId].rtpPortReservations.map(x => this.platform.rtpPorts.freePort(x));
      }

      // Delete the entries.
      delete this.pendingSessions[sessionId];
      delete this.ongoingSessions[sessionId];

      // If we've completed all streaming sessions, restore any changed settings, such as bitrate, for HomeKit Secure Video.
      if (Object.keys(this.ongoingSessions).length === 0) {

        if (this.hksv?.isRecording) {

          // Restart the timeshift buffer now that we've stopped streaming.
          await this.hksv.restartTimeshifting();
        } else if (this.savedBitrate) {

          // Restore our original bitrate.
          if (this.rtspEntry) {

            await this.protectCamera.setBitrate(this.rtspEntry.channel.id, this.savedBitrate);
          }

          this.savedBitrate = 0;
        }
      }

    } catch (error) {

      this.log.error('Error occurred while ending the FFmpeg video processes: %s.', error);
    }
  }

  // Shutdown all our video streams.
  public async shutdown(): Promise<void> {

    for (const session of Object.keys(this.ongoingSessions)) {

      // eslint-disable-next-line no-await-in-loop
      await this.stopStream(session);
    }
  }

  // Adjust our probe hints.
  public adjustProbeSize(): void {

    if (this.probesizeOverrideTimeout) {

      clearTimeout(this.probesizeOverrideTimeout);
      this.probesizeOverrideTimeout = undefined;
    }

    // Maintain statistics on how often we need to adjust our probesize. If this happens too frequently, we will default to a working value.
    this.probesizeOverrideCount++;

    // Increase the probesize by a factor of two each time we need to do something about it. This idea is to balance the latency implications
    // for the user, but also ensuring we have a functional streaming experience.
    this.probesizeOverride = this.probesize * 2;

    // Safety check to make sure this never gets too crazy.
    if (this.probesizeOverride > 5000000) {

      this.probesizeOverride = 5000000;
    }

    this.log.error(
      'The FFmpeg process ended unexpectedly due to issues with the media stream provided by the UniFi Protect livestream API. ' +
      'Adjusting the settings we use for FFmpeg %s to use safer values at the expense of some additional streaming startup latency.',
      this.probesizeOverrideCount < 10 ? 'temporarily' : 'permanently',
    );

    // If this happens often enough, keep the override in place permanently.
    if (this.probesizeOverrideCount < 10) {

      this.probesizeOverrideTimeout = setTimeout(() => {

        this.probesizeOverride = 0;
        this.probesizeOverrideTimeout = undefined;
      }, 1000 * 60 * 10);
    }
  }

  // Utility to return the currently set probesize for a camera.
  public get probesize(): number {

    return this.probesizeOverride ? this.probesizeOverride : this.protectCamera.hints.probesize;
  }

}
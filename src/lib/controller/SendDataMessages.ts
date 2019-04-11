import {
	CommandClass,
	getExpectedCCResponse,
} from "../commandclass/CommandClass";
import {
	ICommandClassContainer,
	isCommandClassContainer,
} from "../commandclass/ICommandClassContainer";
import { IDriver } from "../driver/IDriver";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import {
	FunctionType,
	MessagePriority,
	MessageType,
} from "../message/Constants";
import {
	expectedResponse,
	Message,
	messageTypes,
	priority,
	ResponseRole,
} from "../message/Message";
import { JSONObject } from "../util/misc";

export enum TransmitOptions {
	NotSet = 0,

	ACK = 1 << 0,
	LowPower = 1 << 1,
	AutoRoute = 1 << 2,

	NoRoute = 1 << 4,
	Explore = 1 << 5,

	DEFAULT = ACK | AutoRoute | Explore,
}

// TODO: what is this?
export enum TransmitStatus {
	OK = 0x00, // Transmission complete and ACK received
	NoAck = 0x01, // Transmission complete, no ACK received
	Fail = 0x02, // Transmission failed
	NotIdle = 0x03, // Transmission failed, network busy
	NoRoute = 0x04, // Tranmission complete, no return route
}

let lastCallbackId = 0xff;
function getNextCallbackId(): number {
	lastCallbackId = (lastCallbackId + 1) & 0xff;
	// callback IDs below 10 are reserved for nonce messages
	if (lastCallbackId < 10) lastCallbackId = 10;
	return lastCallbackId;
}

@messageTypes(MessageType.Request, FunctionType.SendData)
@expectedResponse(testResponseForSendDataRequest)
@priority(MessagePriority.Normal)
export class SendDataRequest<CCType extends CommandClass = CommandClass>
	extends Message
	implements ICommandClassContainer {
	// tslint:disable:unified-signatures
	// empty constructor to parse messages
	public constructor(driver: IDriver);
	// default constructor to send messages
	public constructor(
		driver: IDriver,
		command: CCType,
		transmitOptions?: TransmitOptions,
		callbackId?: number,
	);
	public constructor(
		driver: IDriver,
		command?: CCType,
		/** Options regarding the transmission of the message */
		public transmitOptions?: TransmitOptions,
		/** A callback ID to map requests and responses */
		public callbackId?: number,
	) {
		super(driver);
		this.command = command;
		if (command != null) {
			// non-empty constructor -> define default values
			if (this.transmitOptions == null)
				this.transmitOptions = TransmitOptions.DEFAULT;
			if (this.callbackId == null) this.callbackId = getNextCallbackId();
		}
	}
	// tslint:enable:unified-signatures

	/** The command this message contains */
	public command: CCType;

	private _transmitStatus: TransmitStatus;
	public get transmitStatus(): TransmitStatus {
		return this._transmitStatus;
	}

	public serialize(): Buffer {
		if (this.command == null) {
			throw new ZWaveError(
				"Cannot serialize a SendData message without a command",
				ZWaveErrorCodes.PacketFormat_Invalid,
			);
		}
		const serializedCC = this.command.serialize();
		this.payload = Buffer.concat([
			serializedCC,
			Buffer.from([this.transmitOptions, this.callbackId]),
		]);

		return super.serialize();
	}

	// We deserialize SendData requests differently as the controller responses have a different format
	public deserialize(data: Buffer): number {
		const ret = super.deserialize(data);

		this.callbackId = this.payload[0];
		this._transmitStatus = this.payload[1];
		// not sure what bytes 2 and 3 mean
		// the CC seems not to be included in this, but rather come in an application command later

		return ret;
	}

	public toJSON(): JSONObject {
		return super.toJSONInherited({
			transmitOptions: this.transmitOptions,
			callbackId: this.callbackId,
			command: this.command,
			transmitStatus: this.transmitStatus,
		});
	}

	/** Checks if a received SendDataRequest indicates that sending failed */
	public isFailed(): boolean {
		return this._transmitStatus !== TransmitStatus.OK;
	}

	/** @inheritDoc */
	public testResponse(msg: Message): ResponseRole {
		const ret = super.testResponse(msg);
		if (ret === "confirmation" || ret.startsWith("fatal")) return ret;
		if (ret === "unexpected" && !isCommandClassContainer(msg)) return ret;
		// We handle a special case here:
		// If the contained CC expects a certain response (which will come in an "unexpected" ApplicationCommandRequest)
		// we declare that as final and the original "final" response, i.e. the SendDataRequest becomes a confirmation
		const expectedCCOrDynamic = getExpectedCCResponse(this.command);
		const expected =
			typeof expectedCCOrDynamic === "function"
				? expectedCCOrDynamic(this.command)
				: expectedCCOrDynamic;
		if (expected == null) return ret; // "final" | "unexpected"

		if (isCommandClassContainer(msg)) {
			// TODO: Is "confirmation" the correct return value here?
			// Or is it "unexpected"?
			if (expected === msg.command.ccId) {
				return msg.command.expectMoreMessages() ? "partial" : "final";
			}
			// return expected === msg.command.ccId ? "final" : "confirmation"; // not sure if other CCs can come in the meantime
		}
		return "unexpected";
	}

	/** Include previously received partial responses into a final message */
	public mergePartialMessages(partials: Message[]) {
		this.command.mergePartialCCs(
			(partials as SendDataRequest[]).map(p => p.command),
		);
	}
}

@messageTypes(MessageType.Response, FunctionType.SendData)
export class SendDataResponse extends Message {
	private _wasSent: boolean;
	public get wasSent(): boolean {
		return this._wasSent;
	}

	// private _errorCode: number;
	// public get errorCode(): number {
	// 	return this._errorCode;
	// }

	public deserialize(data: Buffer): number {
		const ret = super.deserialize(data);

		this._wasSent = this.payload[0] !== 0;
		// if (!this._wasSent) this._errorCode = this.payload[0];

		return ret;
	}

	public toJSON(): JSONObject {
		return super.toJSONInherited({
			wasSent: this.wasSent,
			// errorCode: this.errorCode,
		});
	}
}

// Generic handler for all potential responses to SendDataRequests
function testResponseForSendDataRequest(
	sent: SendDataRequest,
	received: Message,
): ResponseRole {
	if (received instanceof SendDataResponse) {
		return received.wasSent ? "confirmation" : "fatal_controller";
	} else if (received instanceof SendDataRequest) {
		return received.isFailed() ? "fatal_node" : "final"; // send data requests are final unless stated otherwise by a CommandClass
	}
	return "unexpected";
}

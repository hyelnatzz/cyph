import {ChangeDetectionStrategy, Component, OnDestroy, OnInit} from '@angular/core';
import {ActivatedRoute, Router, UrlSegment} from '@angular/router';
import {BehaviorSubject, combineLatest} from 'rxjs';
import {filter, map, take} from 'rxjs/operators';
import {UserPresence} from '../../account/enums';
import {BaseProvider} from '../../base-provider';
import {States, UiStyles} from '../../chat/enums';
import {
	AccountFileRecord,
	AccountUserTypes,
	CallTypes,
	ChatMessageValue,
	IAppointment
} from '../../proto';
import {accountChatProviders} from '../../providers';
import {AccountChatService} from '../../services/account-chat.service';
import {AccountContactsService} from '../../services/account-contacts.service';
import {AccountFilesService} from '../../services/account-files.service';
import {AccountP2PService} from '../../services/account-p2p.service';
import {AccountSessionService} from '../../services/account-session.service';
import {AccountUserLookupService} from '../../services/account-user-lookup.service';
import {AccountService} from '../../services/account.service';
import {AccountAuthService} from '../../services/crypto/account-auth.service';
import {AccountDatabaseService} from '../../services/crypto/account-database.service';
import {DialogService} from '../../services/dialog.service';
import {EnvService} from '../../services/env.service';
import {FileTransferService} from '../../services/file-transfer.service';
import {NotificationService} from '../../services/notification.service';
import {P2PWebRTCService} from '../../services/p2p-webrtc.service';
import {StringsService} from '../../services/strings.service';
import {toBehaviorSubject} from '../../util/flatten-observable';
import {normalize} from '../../util/formatting';
import {lockFunction} from '../../util/lock';
import {getDateTimeString, getTimestamp} from '../../util/time';
import {sleep} from '../../util/wait';


/**
 * Angular component for account chat UI.
 */
@Component({
	changeDetection: ChangeDetectionStrategy.OnPush,
	providers: accountChatProviders,
	selector: 'cyph-account-chat',
	styleUrls: ['./account-chat.component.scss'],
	templateUrl: './account-chat.component.html'
})
export class AccountChatComponent extends BaseProvider implements OnDestroy, OnInit {
	/** @ignore */
	private initiatedAppointmentID?: string;

	/** @ignore */
	private initiatedContactID?: string;

	/** @see AccountUserTypes */
	public readonly accountUserTypes		= AccountUserTypes;

	/** Indicates whether this user is the call recipient. */
	public readonly answering				= new BehaviorSubject<boolean>(false);

	/** Appointment data, when applicable. */
	public readonly appointment				=
		new BehaviorSubject<(IAppointment&{id: string})|undefined>(undefined)
	;

	/** @see AccountCallWaiting.cancelRedirectsHome */
	public readonly cancelRedirectsHome		= toBehaviorSubject(
		combineLatest(
			this.answering,
			this.accountService.combinedRouteData(this.activatedRoute)
		).pipe(map(([answering, [{cancelRedirectsHome}]]) =>
			answering || cancelRedirectsHome === true
		)),
		false
	);

	/** @see ChatMessageValue.Types */
	public readonly chatMessageValueTypes	=
		ChatMessageValue.Types
	;

	/** Indicates whether call is pending or not yet loaded. */
	public readonly initialCallPending		= combineLatest(
		this.p2pWebRTCService.initialCallPending,
		this.p2pWebRTCService.loading
	).pipe(map(([initialCallPending, loading]) =>
		initialCallPending || loading
	));

	/** Initial load screen before a user is set. */
	public readonly initiating				= new BehaviorSubject<boolean>(true);

	/** @see ChatMessageValue.Types */
	public readonly messageType				= new BehaviorSubject<ChatMessageValue.Types>(
		this.envService.isTelehealth ?
			ChatMessageValue.Types.Quill :
			ChatMessageValue.Types.Text
	);

	/** @see ChatMessageList.promptFollowup */
	public readonly promptFollowup			=
		new BehaviorSubject<string|undefined>(undefined)
	;

	/** Sub-session ID. */
	public readonly sessionSubID			= new BehaviorSubject<string|undefined>(undefined);

	/** @see States */
	public readonly states					= States;

	/** @see UiStyles */
	public readonly uiStyles				= UiStyles;

	/** @see UserPresence */
	public readonly userPresence			= UserPresence;

	/** @ignore */
	private async navigate (...url: string[]) : Promise<void> {
		this.destroyed.next(true);
		this.router.navigate([accountRoot, 'chat-transition'], {skipLocationChange: true});
		await sleep(0);
		this.router.navigate([accountRoot, ...url]);
	}

	/** @inheritDoc */
	public async ngOnDestroy () : Promise<void> {
		super.ngOnDestroy();

		if (this.p2pWebRTCService.isActive) {
			await this.p2pWebRTCService.close();
		}

		await this.accountSessionService.destroy();
	}

	/** @inheritDoc */
	public ngOnInit () : void {
		this.accountService.transitionEnd();

		const lock	= lockFunction();

		this.subscriptions.push(this.accountService.combinedRouteData(
			this.activatedRoute
		).subscribe(async ([
			{callType, defaultSessionSubID, ephemeralSubSession, promptFollowup},
			{answerExpireTime, appointmentID, contactID, sessionSubID, username},
			[{path}]
		]: [
			{
				callType?: 'audio'|'video';
				defaultSessionSubID?: string;
				ephemeralSubSession?: boolean;
				promptFollowup?: boolean;
			},
			{
				answerExpireTime?: number;
				appointmentID?: string;
				contactID?: string;
				sessionSubID?: string;
				username?: string;
			},
			UrlSegment[]
		/* tslint:disable-next-line:cyclomatic-complexity */
		]) => lock(async () => {
			if (this.destroyed.value) {
				return;
			}

			this.answering.next(answerExpireTime !== undefined);

			try {
				if (username) {
					const user	= await this.accountUserLookupService.getUser(username, false);
					if (user) {
						this.router.navigate(
							[accountRoot, path, await user.contactID],
							{replaceUrl: true}
						);
					}
					return;
				}

				if (this.initiatedAppointmentID) {
					if (appointmentID && this.initiatedAppointmentID !== appointmentID) {
						await this.navigate('appointments', path, appointmentID);
					}

					return;
				}

				if (this.initiatedContactID) {
					if (contactID && this.initiatedContactID !== contactID) {
						await this.navigate(path, contactID);
					}

					return;
				}

				let appointment: IAppointment&{id: string};
				let appointmentOther: string|undefined;

				if (appointmentID) {
					appointment			= {
						id: appointmentID,
						...(await this.accountFilesService.downloadFile(
							appointmentID,
							AccountFileRecord.RecordTypes.Appointment
						).result)
					};

					callType			=
						promptFollowup ?
							undefined :
						appointment.calendarInvite.callType === CallTypes.Video ?
							'video' :
						appointment.calendarInvite.callType === CallTypes.Audio ?
							'audio' :
							undefined
					;

					sessionSubID		= appointmentID;

					appointmentOther	=
						appointment.participants === undefined ?
							undefined :
							appointment.participants.find(participant =>
								this.accountDatabaseService.currentUser.value !== undefined &&
								(
									this.accountDatabaseService.currentUser.value.user.username
								) !== normalize(participant)
							)
					;

					contactID		= await this.accountContactsService.getContactID(
						appointmentOther
					);

					this.appointment.next(appointment);
				}

				this.initiatedAppointmentID	= appointmentID;
				this.initiatedContactID		= contactID;

				if (!contactID) {
					return;
				}

				const callEndRoute	= appointmentID ?
					[accountRoot, 'appointments', appointmentID, 'end'] :
				!this.cancelRedirectsHome.value ?
					[accountRoot, 'messages', contactID] :
					[accountRoot]
				;

				if (
					answerExpireTime !== undefined &&
					(await getTimestamp()) > answerExpireTime
				) {
					this.dialogService.toast(this.stringsService.p2pTimeoutIncoming, 3000);
					this.router.navigate(callEndRoute);
					return;
				}

				if (defaultSessionSubID && !sessionSubID) {
					sessionSubID	= defaultSessionSubID;
				}

				this.messageType.next(
					sessionSubID === 'mail' || this.envService.isTelehealth ?
						ChatMessageValue.Types.Quill :
						ChatMessageValue.Types.Text
				);

				this.sessionSubID.next(sessionSubID);

				this.p2pWebRTCService.initialCallPending.next(callType !== undefined);

				this.accountChatService.enableVirtualScroll.next(
					this.messageType.value === ChatMessageValue.Types.Text
				);

				const chat	= await this.accountContactsService.getChatData(contactID);

				if (callType !== undefined && !sessionSubID) {
					await this.accountChatService.setUser(chat);
					return this.accountP2PService.beginCall(callType, path);
				}
				else {
					this.initiating.next(false);

					await this.accountChatService.setUser(
						chat,
						undefined,
						callType,
						sessionSubID,
						ephemeralSubSession
					);
				}

				if (callType === undefined) {
					return;
				}

				if (!(await (
					this.answering.value ?
						this.accountP2PService.handlers.acceptConfirm(callType) :
						this.accountP2PService.handlers.requestConfirm(callType)
				))) {
					this.router.navigate(callEndRoute);
					return;
				}

				this.notificationService.ring(Promise.race([
					this.p2pWebRTCService.loading.pipe(filter(b => b), take(1)).toPromise(),
					this.destroyed.pipe(filter(b => b), take(1)).toPromise().then(() => false)
				])).then(() => {
					if (
						this.destroyed.value ||
						this.p2pWebRTCService.loading.value ||
						!this.p2pWebRTCService.initialCallPending.value
					) {
						return;
					}

					this.dialogService.toast(this.stringsService.p2pTimeoutOutgoing, 3000);
					this.p2pWebRTCService.close();
				});

				this.p2pWebRTCService.disconnect.pipe(take(1)).toPromise().then(async () => {
					if (!this.destroyed.value) {
						this.router.navigate(callEndRoute);

						if (appointment && appointmentID) {
							appointment.occurred	= true;

							await this.accountFilesService.updateAppointment(
								appointmentID,
								appointment,
								undefined,
								true
							);

							if (appointment.notes && appointmentOther) {
								await this.accountFilesService.upload(
									`Notes about ${appointmentOther} (${
										appointment.calendarInvite.title
									}, ${
										getDateTimeString(appointment.calendarInvite.startTime)
									})`,
									appointment.notes
								);
							}
						}
					}
				});
			}
			catch {
				this.router.navigate([accountRoot, '404']);
			}
			finally {
				if (promptFollowup) {
					this.promptFollowup.next(contactID || this.initiatedContactID);
				}
				else {
					this.promptFollowup.next(undefined);
				}
			}
		})));
	}

	constructor (
		/** @ignore */
		private readonly activatedRoute: ActivatedRoute,

		/** @ignore */
		private readonly router: Router,

		/** @ignore */
		private readonly accountUserLookupService: AccountUserLookupService,

		/** @ignore */
		private readonly accountFilesService: AccountFilesService,

		/** @ignore */
		private readonly dialogService: DialogService,

		/** @ignore */
		private readonly notificationService: NotificationService,

		/** @see AccountService */
		public readonly accountService: AccountService,

		/** @see AccountAuthService */
		public readonly accountAuthService: AccountAuthService,

		/** @see AccountChatService */
		public readonly accountChatService: AccountChatService,

		/** @see AccountContactsService */
		public readonly accountContactsService: AccountContactsService,

		/** @see AccountDatabaseService */
		public readonly accountDatabaseService: AccountDatabaseService,

		/** @see AccountP2PService */
		public readonly accountP2PService: AccountP2PService,

		/** @see AccountSessionService */
		public readonly accountSessionService: AccountSessionService,

		/** @see EnvService */
		public readonly envService: EnvService,

		/** @see FileTransferService */
		public readonly fileTransferService: FileTransferService,

		/** @see P2PWebRTCService */
		public readonly p2pWebRTCService: P2PWebRTCService,

		/** @see StringsService */
		public readonly stringsService: StringsService
	) {
		super();
	}
}

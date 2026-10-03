// The files waiting to go with the next words (above the box), the paperclip that picks them, and the
// files a sent line carried (in the stream).
import { useRef } from 'react';
import type { Attachment } from '../../shared/protocol.js';
import { buildMediaUrl } from '../media.js';
import type { Attachments } from '../use-attachments.js';

const formatBytes = (bytes: number): string =>
	bytes >= 1024 * 1024
		? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
		: bytes >= 1024
			? `${Math.round(bytes / 1024)} KB`
			: `${bytes} B`;

const FileBody = ({ attachment }: { attachment: Attachment }) =>
	attachment.mediaName ? (
		<img src={buildMediaUrl(attachment.mediaName)} alt={attachment.name} loading="lazy" />
	) : (
		<>
			<span className="att-name">{attachment.name}</span>
			{/* A file named again from a past run has no size kept. */}
			{attachment.bytes > 0 && <span className="att-size">{formatBytes(attachment.bytes)}</span>}
		</>
	);

export const AttachmentChips = ({ attachments }: { attachments: Attachments }) => {
	const { waiting, uploads, note } = attachments;

	if (waiting.length === 0 && uploads.length === 0 && !note) {
		return null;
	}

	return (
		<section className="att-row" aria-label="attached files">
			{waiting.map((attachment) => (
				<div
					key={attachment.id}
					className={`att-chip ${attachment.mediaName ? 'thumb' : ''}`}
					title={attachment.name}
				>
					<FileBody attachment={attachment} />
					<button
						type="button"
						className="att-x"
						aria-label={`Remove ${attachment.name}`}
						onClick={() => attachments.remove(attachment.id)}
					>
						✕
					</button>
				</div>
			))}
			{uploads.map((upload) => (
				<div
					key={upload.key}
					className={`att-chip ${upload.error ? 'refused' : 'uploading'}`}
					title={upload.name}
				>
					<span className="att-name">{upload.name}</span>
					<span className="att-size">{upload.error ?? 'uploading…'}</span>
					{upload.error && (
						<button
							type="button"
							className="att-x"
							aria-label={`Dismiss ${upload.name}`}
							onClick={() => attachments.dismiss(upload.key)}
						>
							✕
						</button>
					)}
				</div>
			))}
			{note && (
				<span className="att-note" role="status">
					{note}
				</span>
			)}
		</section>
	);
};

export const AttachButton = ({ attachments }: { attachments: Attachments }) => {
	const inputRef = useRef<HTMLInputElement | null>(null);

	return (
		<>
			<button
				type="button"
				className="btn sm ghost att-clip"
				aria-label="Attach files"
				title="Attach files (or paste, or drop them here)"
				onClick={() => inputRef.current?.click()}
			>
				<svg
					width="15"
					height="15"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<path d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5L9 2.5a2.1 2.1 0 0 1 3 3L6.6 11a1 1 0 0 1-1.5-1.5L10 4.6" />
				</svg>
			</button>
			<input
				ref={inputRef}
				type="file"
				multiple
				hidden
				onChange={(event) => {
					attachments.attach([...(event.target.files ?? [])]);
					// The same file picked again is a new pick.
					event.target.value = '';
				}}
			/>
		</>
	);
};

export const AttachedFiles = ({ attachments }: { attachments: Attachment[] }) => (
	<div className="att-row sent">
		{attachments.map((attachment) =>
			attachment.mediaName ? (
				<a
					key={attachment.id}
					className="att-chip thumb"
					href={buildMediaUrl(attachment.mediaName)}
					target="_blank"
					rel="noopener noreferrer"
					title={attachment.name}
				>
					<FileBody attachment={attachment} />
				</a>
			) : (
				<span key={attachment.id} className="att-chip" title={attachment.name}>
					<FileBody attachment={attachment} />
				</span>
			),
		)}
	</div>
);

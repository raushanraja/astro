import type { AstroConfig } from '../../@types/astro.js';
import { AstroError, AstroErrorData } from '../../core/errors/index.js';
import { isRemotePath, joinPaths } from '../../core/path.js';
import { DEFAULT_OUTPUT_FORMAT, VALID_SUPPORTED_FORMATS } from '../consts.js';
import { isESMImportedImage, isRemoteAllowed } from '../internal.js';
import type { ImageOutputFormat, ImageTransform } from '../types.js';

export type ImageService = LocalImageService | ExternalImageService;

export function isLocalService(service: ImageService | undefined): service is LocalImageService {
	if (!service) {
		return false;
	}

	return 'transform' in service;
}

export function parseQuality(quality: string): string | number {
	let result = parseInt(quality);
	if (Number.isNaN(result)) {
		return quality;
	}

	return result;
}

type ImageConfig<T> = Omit<AstroConfig['image'], 'service'> & {
	service: { entrypoint: string; config: T };
};

type SrcSetValue = {
	transform: ImageTransform;
	descriptor?: string;
	attributes?: Record<string, any>;
};

interface SharedServiceProps<T extends Record<string, any> = Record<string, any>> {
	/**
	 * Return the URL to the endpoint or URL your images are generated from.
	 *
	 * For a local service, your service should expose an endpoint handling the image requests, or use Astro's at `/_image`.
	 *
	 * For external services, this should point to the URL your images are coming from, for instance, `/_vercel/image`
	 *
	 */
	getURL: (options: ImageTransform, imageConfig: ImageConfig<T>) => string | Promise<string>;
	/**
	 * Generate additional `srcset` values for the image.
	 *
	 * While in most cases this is exclusively used for `srcset`, it can also be used in a more generic way to generate
	 * multiple variants of the same image. For instance, you can use this to generate multiple aspect ratios or multiple formats.
	 */
	getSrcSet?: (
		options: ImageTransform,
		imageConfig: ImageConfig<T>
	) => SrcSetValue[] | Promise<SrcSetValue[]>;
	/**
	 * Return any additional HTML attributes separate from `src` that your service requires to show the image properly.
	 *
	 * For example, you might want to return the `width` and `height` to avoid CLS, or a particular `class` or `style`.
	 * In most cases, you'll want to return directly what your user supplied you, minus the attributes that were used to generate the image.
	 */
	getHTMLAttributes?: (
		options: ImageTransform,
		imageConfig: ImageConfig<T>
	) => Record<string, any> | Promise<Record<string, any>>;
	/**
	 * Validate and return the options passed by the user.
	 *
	 * This method is useful to present errors to users who have entered invalid options.
	 * For instance, if they are missing a required property or have entered an invalid image format.
	 *
	 * This method should returns options, and can be used to set defaults (ex: a default output format to be used if the user didn't specify one.)
	 */
	validateOptions?: (
		options: ImageTransform,
		imageConfig: ImageConfig<T>
	) => ImageTransform | Promise<ImageTransform>;
}

export type ExternalImageService<T extends Record<string, any> = Record<string, any>> =
	SharedServiceProps<T>;

export type LocalImageTransform = {
	src: string;
	[key: string]: any;
};

export interface LocalImageService<T extends Record<string, any> = Record<string, any>>
	extends SharedServiceProps<T> {
	/**
	 * Parse the requested parameters passed in the URL from `getURL` back into an object to be used later by `transform`.
	 *
	 * In most cases, this will get query parameters using, for example, `params.get('width')` and return those.
	 */
	parseURL: (
		url: URL,
		imageConfig: ImageConfig<T>
	) => LocalImageTransform | undefined | Promise<LocalImageTransform> | Promise<undefined>;
	/**
	 * Performs the image transformations on the input image and returns both the binary data and
	 * final image format of the optimized image.
	 */
	transform: (
		inputBuffer: Buffer,
		transform: LocalImageTransform,
		imageConfig: ImageConfig<T>
	) => Promise<{ data: Buffer; format: ImageOutputFormat }>;
}

export type BaseServiceTransform = {
	src: string;
	width?: number;
	height?: number;
	format: string;
	quality?: string | null;
};

/**
 * Basic local service using the included `_image` endpoint.
 * This service intentionally does not implement `transform`.
 *
 * Example usage:
 * ```ts
 * const service = {
 *  getURL: baseService.getURL,
 *  parseURL: baseService.parseURL,
 *  getHTMLAttributes: baseService.getHTMLAttributes,
 *  async transform(inputBuffer, transformOptions) {...}
 * }
 * ```
 *
 * This service adhere to the included services limitations:
 * - Remote images are passed as is.
 * - Only a limited amount of formats are supported.
 * - For remote images, `width` and `height` are always required.
 *
 */
export const baseService: Omit<LocalImageService, 'transform'> = {
	validateOptions(options) {
		// `src` is missing or is `undefined`.
		if (!options.src || (typeof options.src !== 'string' && typeof options.src !== 'object')) {
			throw new AstroError({
				...AstroErrorData.ExpectedImage,
				message: AstroErrorData.ExpectedImage.message(
					JSON.stringify(options.src),
					typeof options.src,
					JSON.stringify(options, (_, v) => (v === undefined ? null : v))
				),
			});
		}

		if (!isESMImportedImage(options.src)) {
			// User passed an `/@fs/` path or a filesystem path instead of the full image.
			if (
				options.src.startsWith('/@fs/') ||
				(!isRemotePath(options.src) && !options.src.startsWith('/'))
			) {
				throw new AstroError({
					...AstroErrorData.LocalImageUsedWrongly,
					message: AstroErrorData.LocalImageUsedWrongly.message(options.src),
				});
			}

			// For remote images, width and height are explicitly required as we can't infer them from the file
			let missingDimension: 'width' | 'height' | 'both' | undefined;
			if (!options.width && !options.height) {
				missingDimension = 'both';
			} else if (!options.width && options.height) {
				missingDimension = 'width';
			} else if (options.width && !options.height) {
				missingDimension = 'height';
			}

			if (missingDimension) {
				throw new AstroError({
					...AstroErrorData.MissingImageDimension,
					message: AstroErrorData.MissingImageDimension.message(missingDimension, options.src),
				});
			}
		} else {
			if (!VALID_SUPPORTED_FORMATS.includes(options.src.format as any)) {
				throw new AstroError({
					...AstroErrorData.UnsupportedImageFormat,
					message: AstroErrorData.UnsupportedImageFormat.message(
						options.src.format,
						options.src.src,
						VALID_SUPPORTED_FORMATS
					),
				});
			}

			if (options.widths && options.densities) {
				throw new AstroError(AstroErrorData.IncompatibleDescriptorOptions);
			}

			// We currently do not support processing SVGs, so whenever the input format is a SVG, force the output to also be one
			if (options.src.format === 'svg') {
				options.format = 'svg';
			}

			if (
				(options.src.format === 'svg' && options.format !== 'svg') ||
				(options.src.format !== 'svg' && options.format === 'svg')
			) {
				throw new AstroError(AstroErrorData.UnsupportedImageConversion);
			}
		}

		// If the user didn't specify a format, we'll default to `webp`. It offers the best ratio of compatibility / quality
		// In the future, hopefully we can replace this with `avif`, alas, Edge. See https://caniuse.com/avif
		if (!options.format) {
			options.format = DEFAULT_OUTPUT_FORMAT;
		}

		// Sometimes users will pass number generated from division, which can result in floating point numbers
		if (options.width) options.width = Math.round(options.width);
		if (options.height) options.height = Math.round(options.height);

		return options;
	},
	getHTMLAttributes(options) {
		const { targetWidth, targetHeight } = getTargetDimensions(options);
		const { src, width, height, format, quality, densities, widths, formats, ...attributes } =
			options;

		return {
			...attributes,
			width: targetWidth,
			height: targetHeight,
			loading: attributes.loading ?? 'lazy',
			decoding: attributes.decoding ?? 'async',
		};
	},
	getSrcSet(options) {
		const srcSet: SrcSetValue[] = [];
		const { targetWidth } = getTargetDimensions(options);
		const { widths, densities } = options;
		const targetFormat = options.format ?? DEFAULT_OUTPUT_FORMAT;

		// For remote images, we don't know the original image's dimensions, so we cannot know the maximum width
		// It is ultimately the user's responsibility to make sure they don't request images larger than the original
		let imageWidth = options.width;
		let maxWidth = Infinity;

		// However, if it's an imported image, we can use the original image's width as a maximum width
		if (isESMImportedImage(options.src)) {
			imageWidth = options.src.width;
			maxWidth = imageWidth;
		}

		// Since `widths` and `densities` ultimately control the width and height of the image,
		// we don't want the dimensions the user specified, we'll create those ourselves.
		const {
			width: transformWidth,
			height: transformHeight,
			...transformWithoutDimensions
		} = options;

		// Collect widths to generate from specified densities or widths
		const allWidths: { maxTargetWidth: number; descriptor: `${number}x` | `${number}w` }[] = [];
		if (densities) {
			// Densities can either be specified as numbers, or descriptors (ex: '1x'), we'll convert them all to numbers
			const densityValues = densities.map((density) => {
				if (typeof density === 'number') {
					return density;
				} else {
					return parseFloat(density);
				}
			});

			// Calculate the widths for each density, rounding to avoid floats.
			const densityWidths = densityValues
				.sort()
				.map((density) => Math.round(targetWidth * density));

			allWidths.push(
				...densityWidths.map((width, index) => ({
					maxTargetWidth: Math.min(width, maxWidth),
					descriptor: `${densityValues[index]}x` as const,
				}))
			);
		} else if (widths) {
			allWidths.push(
				...widths.map((width) => ({
					maxTargetWidth: Math.min(width, maxWidth),
					descriptor: `${width}w` as const,
				}))
			);
		}

		// Caution: The logic below is a bit tricky, as we need to make sure we don't generate the same image multiple times
		// When making changes, make sure to test with different combinations of local/remote images widths, densities, and dimensions etc.
		for (const { maxTargetWidth, descriptor } of allWidths) {
			const srcSetTransform: ImageTransform = { ...transformWithoutDimensions };

			// Only set the width if it's different from the original image's width, to avoid generating the same image multiple times
			if (maxTargetWidth !== imageWidth) {
				srcSetTransform.width = maxTargetWidth;
			} else {
				// If the width is the same as the original image's width, and we have both dimensions, it probably means
				// it's a remote image, so we'll use the user's specified dimensions to avoid recreating the original image unnecessarily
				if (options.width && options.height) {
					srcSetTransform.width = options.width;
					srcSetTransform.height = options.height;
				}
			}

			srcSet.push({
				transform: srcSetTransform,
				descriptor,
				attributes: {
					type: `image/${targetFormat}`,
				},
			});
		}

		return srcSet;
	},
	getURL(options, imageConfig) {
		const searchParams = new URLSearchParams();

		if (isESMImportedImage(options.src)) {
			searchParams.append('href', options.src.src);
		} else if (isRemoteAllowed(options.src, imageConfig)) {
			searchParams.append('href', options.src);
		} else {
			// If it's not an imported image, nor is it allowed using the current domains or remote patterns, we'll just return the original URL
			return options.src;
		}

		const params: Record<string, keyof typeof options> = {
			w: 'width',
			h: 'height',
			q: 'quality',
			f: 'format',
		};

		Object.entries(params).forEach(([param, key]) => {
			options[key] && searchParams.append(param, options[key].toString());
		});

		const imageEndpoint = joinPaths(import.meta.env.BASE_URL, '/_image');
		return `${imageEndpoint}?${searchParams}`;
	},
	parseURL(url) {
		const params = url.searchParams;

		if (!params.has('href')) {
			return undefined;
		}

		const transform: BaseServiceTransform = {
			src: params.get('href')!,
			width: params.has('w') ? parseInt(params.get('w')!) : undefined,
			height: params.has('h') ? parseInt(params.get('h')!) : undefined,
			format: params.get('f') as ImageOutputFormat,
			quality: params.get('q'),
		};

		return transform;
	},
};

/**
 * Returns the final dimensions of an image based on the user's options.
 *
 * For local images:
 * - If the user specified both width and height, we'll use those.
 * - If the user specified only one of them, we'll use the original image's aspect ratio to calculate the other.
 * - If the user didn't specify either, we'll use the original image's dimensions.
 *
 * For remote images:
 * - Widths and heights are always required, so we'll use the user's specified width and height.
 */
function getTargetDimensions(options: ImageTransform) {
	let targetWidth = options.width;
	let targetHeight = options.height;
	if (isESMImportedImage(options.src)) {
		const aspectRatio = options.src.width / options.src.height;
		if (targetHeight && !targetWidth) {
			// If we have a height but no width, use height to calculate the width
			targetWidth = Math.round(targetHeight * aspectRatio);
		} else if (targetWidth && !targetHeight) {
			// If we have a width but no height, use width to calculate the height
			targetHeight = Math.round(targetWidth / aspectRatio);
		} else if (!targetWidth && !targetHeight) {
			// If we have neither width or height, use the original image's dimensions
			targetWidth = options.src.width;
			targetHeight = options.src.height;
		}
	}

	// TypeScript doesn't know this, but because of previous hooks we always know that targetWidth and targetHeight are defined
	return {
		targetWidth: targetWidth!,
		targetHeight: targetHeight!,
	};
}

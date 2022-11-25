document.addEventListener("DOMContentLoaded", evt => {
	"use strict";
	const report = s => {
		const out = document.querySelector("#reports");
		out.textContent = s + "\n" + out.textContent;
	};

	const crc32 = (reg, s) => {
		for (let j = 0; j < s.length; j++) {
			let x = (s[j] ^ reg) & 255;
			for (let k = 0; k < 8; k++)
				x = (x>>>1) ^ (x&1)*0xedb88320;
			reg = x ^ (reg>>>8);
		}
		return reg;
	};

	const huffEncode = (srcbuf, off, len) => {
		const src = new Uint8Array(srcbuf, off, len);
		if (src.length >= 0x1000000)
			throw "too big to huf";

		const freqs = new Uint32Array(256);
		for (const ch of src)
			freqs[ch]++;

		const queue = [];
		for (let j = 255; j >= 0; j--) {
			if (freqs[j])
				queue.push([freqs[j], 1, j]);
		}
		if (queue.length == 1)
			queue.push([0, 1, 255^queue[0][2]]);
		const stems = [];
		let encbits = 0;
		for (let j = queue.length; j > 1; j--) {
			queue.sort((a,b) => a[0]-b[0]);
			const [x1,x0] = queue.splice(0, 2);
			const freq = x1[0] + x0[0];
			encbits += freq;
			queue.push([freq, 0, stems.length])
			stems.push([x1[1]+2*x0[1], x0[2], x1[2]]);
		}
		stems.push([2, stems.length, stems.length-1]);

		const outlen = 4 + 2*stems.length + ((((encbits-1)|31)+1)>>3);
		const outbuf = new Uint8Array(outlen);
		outbuf[0] = 0x28;
		outbuf[1] = src.length;
		outbuf[2] = src.length >> 8;
		outbuf[3] = src.length >> 16;


		const place = new Uint8Array(stems.length);
		for (let j = stems.length-1; j >= 0; j--) {
			let m = 0;
			for (let k = 0; k < stems.length; k++) {
				if (place[k])
					continue;

				const s = stems[k];
				if ((!(s[0] & 2) && place[s[1]] >= j+64) || (!(s[0] & 1) && place[s[2]] >= j+64)) {
					m = k;
					break;
				}

				if (m == 0 && s[0] == 0 && (place[s[1]] || place[s[2]])) {
					const Q = [k];
					let L=0, R=1;
					while (L < R) {
						const w = stems[Q[L++]];
						if (!(w[0] & 2) && !place[w[1]])
							Q[R++] = w[1];
						if (!(w[0] & 1) && !place[w[2]])
							Q[R++] = w[2];
					}
					if (R > 1)
						m = Q[R-1];
				}
			}
			while (place[m])
				m++;

			const t = stems[m];
			if (t[0] & 2)
				outbuf[4+2*j+0] = t[1];
			else if (place[t[1]] <= j+64)
				outbuf[4+2*j+0] = stems[t[1]][0] << 6 | place[t[1]]-j-1;
			else throw `oops ${t[1]} ${place[t[1]]} ${j}`;

			if (t[0] & 1)
				outbuf[4+2*j+1] = t[2];
			else if (place[t[2]] <= j+64)
				outbuf[4+2*j+1] = stems[t[2]][0] << 6 | place[t[2]]-j-1;
			else throw `oops ${t[2]} ${place[t[2]]} ${j}`;

			place[m] = j;
		}

		const lookup = new Uint32Array(256);
		if (stems.length >= 2) {
			const buildLookup = (n, w, b) => {
				const s = stems[n];

				if (s[0] & 2)
					lookup[s[1]] = (w+1) | b << 6;
				else
					buildLookup(s[1], w+1, b << 1);

				if (s[0] & 1)
					lookup[s[2]] = (w+1) | b << 6 | 1 << 5;
				else
					buildLookup(s[2], w+1, b << 1 | 1);
			};
			buildLookup(stems.length-2, 0, 0)
		}

		let word = 0, bits = 32;
		let dp = 4 + 2*stems.length;
		for (let sp = 0; sp < src.length; sp++) {
			let ch = src[sp];
			bits -= lookup[ch] & 31;
			if (bits < 0) {
				word |= lookup[ch] >> (5-bits);
				outbuf[dp++] = word;
				outbuf[dp++] = word >> 8;
				outbuf[dp++] = word >> 16;
				outbuf[dp++] = word >> 24;
				bits += 32;
				word = 0;
			}
			word |= (lookup[ch] >> 5) << bits;
		}
		outbuf[dp++] = word;
		outbuf[dp++] = word >> 8;
		outbuf[dp++] = word >> 16;
		outbuf[dp++] = word >> 24;

		return outbuf;
	};

	const huffDecode = (srcbuf, off, len) => {
		const src = new Uint8Array(srcbuf, off, len);
		if (src.length <= 6 || src.length <= 6 + 2*src[4])
			throw "huf buf insuf";
		if (src[0] != 0x28)
			throw "not huffman mode 28";

		const outlen = (src[1] | src[2] << 8 | src[3] << 16);
		const outbuf = new Uint8Array(outlen);

		const tree = src.subarray(4, 6 + 2*src[4]);
		let entry = tree[1];
		let pos = 0;

		let dp = 0;
		for (let sp = 6 + 2*src[4]; sp < len; sp += 4) {
			for (let sq = sp+3; sq >= sp; sq--) {
				for (let k = 128; k > 0; k >>= 1) {
					pos += (entry & 0x3f) + 1;
					if (pos > tree[0])
						throw "pos out of tree";

					let isleaf = false;
					if (src[sq] & k) {
						isleaf = entry & 0x40;
						entry = tree[2*pos+1];
					}
					else {
						isleaf = entry & 0x80;
						entry = tree[2*pos];
					}

					if (isleaf) {
						outbuf[dp++] = entry;
						if (dp >= outlen) {
							if (len-sp != 4)
								report(`file had ${len-sp} trailing bytes`);
							return outbuf;
						}
						entry = tree[1];
						pos = 0;
					}
				}
			}
		}

		report(`file ended with ${outlen-dp} bytes missing`);
		return outbuf;
	}

	const processFiles = async (files, zipname) => {
		const outfiles = {};
		for (const file of files) {
			const data = new DataView(await file.arrayBuffer());

			let sectyp = 0;
			let offset = 0;
			for (; offset <= 1024 && offset+3 < data.byteLength; offset += 64) {
				let word = data.getUint32(offset, true);
				if (word == 0x434f4d50 || word == 0x494e4445) {
					sectyp = word;
					break;
				}
			}

			if (sectyp == 0) {
				report(`${file.name} was probably not a 3dsfe save file`);
				continue;
			}

			const header = new Uint8Array(data.buffer, 0, offset);
			if (sectyp == 0x434f4d50) {
				const expectlen = data.getUint32(offset+8, true);
				const expectcrc = data.getInt32(offset+12, true);
				const hufset = offset+16;
				if (data.getUint8(hufset) != 0x28) {
					report(`skipped ${file.name}: unknown compression format`);
					continue;
				}
				const dec = huffDecode(data.buffer, offset+16, data.byteLength-hufset);

				if (dec.byteLength != expectlen)
					report(`${file.name} size ${dec.byteLength} not expected ${expectlen}`)
				const crc = ~crc32(crc32(~0, header), dec);
				if (crc != expectcrc)
					report(`${file.name} crc ${crc.toString(16)} not expected ${expectcrc.toString(16)}`)

				let outname;
				if (file.name.slice(-4) == "_enc")
					outname = file.name.slice(0, -4);
				else
					outname = file.name + "_dec";
				outfiles[outname] = new Blob([header, dec]);
			}
			else {
				const crc = ~crc32(~0, data);
				const declen = data.byteLength - offset;
				const pmocHeader = new Uint8Array([
					80, 77, 79, 67, 2, 0, 0, 0,
					declen, declen >> 8, declen >> 16, declen >> 24,
					crc, crc >> 8, crc >> 16, crc >> 24]);
				const enc = huffEncode(data.buffer, offset, declen);
				let outname;
				if (file.name.slice(-4) == "_dec")
					outname = file.name.slice(0, -4);
				else
					outname = file.name + "_enc";
				outfiles[outname] = new Blob([header, pmocHeader, enc]);
			}
		}

		const outnames = Object.keys(outfiles);
		if (outnames.length == 0)
			report("nothing to output");
		else if (outnames.length == 1) {
				const a = document.createElement("a");
				a.download = outnames[0];
				a.href = URL.createObjectURL(outfiles[outnames[0]]);
				a.click();
		}
		else {
			let enc = new TextEncoder("utf-8");
			let now = new Date();
			const acc = [];
			const cdr = []
			let offset = 0;

			for (const name of outnames) {
				let encname = enc.encode(name);
				let content = new Uint8Array(await outfiles[name].arrayBuffer());
				let crc = ~crc32(~0, content);
				let len = content.byteLength;
				cdr.push(new Uint8Array([
					80, 75, 1, 2, 0, 0, 0, 0, 0, 8, 0, 0,
					now.getSeconds() >> 2 | now.getMinutes() << 5,
					now.getMinutes() >> 3 | now.getHours() << 3,
					now.getDate() | now.getMonth() << 5,
					now.getMonth() >> 7 | (now.getFullYear()-1980) << 1,
					crc, crc >> 8, crc >> 16, crc >> 24,
					len, len >> 8, len >> 16, len >> 24,
					len, len >> 8, len >> 16, len >> 24,
					encname.byteLength, encname.byteLength >> 8, 0, 0, 0, 0,
					0, 0, 0, 0, 0, 0, 0, 0,
					offset, offset >> 8, offset >> 16, offset >> 24]));
				cdr.push(encname);
				let header = new Uint8Array([
					80, 75, 3, 4, 0, 0, 0, 8, 0, 0,
					now.getSeconds() >> 2 | now.getMinutes() << 5,
					now.getMinutes() >> 3 | now.getHours() << 3,
					now.getDate() | now.getMonth() << 5,
					now.getMonth() >> 7 | (now.getFullYear()-1980) << 1,
					crc, crc >> 8, crc >> 16, crc >> 24,
					len, len >> 8, len >> 16, len >> 24,
					len, len >> 8, len >> 16, len >> 24,
					encname.byteLength, encname.byteLength >> 8, 0, 0]);
				acc.push(header, encname, content);
				offset += header.byteLength + encname.byteLength + content.byteLength;
			}

			let dirlen = cdr.reduce((a, b) => a+b.byteLength, 0);
			cdr.push(new Uint8Array([
				80, 75, 5, 6, 0, 0, 0, 0,
				cdr.length >> 1, cdr.length >> 9,
				cdr.length >> 1, cdr.length >> 9,
				dirlen, dirlen >> 8, dirlen >> 16, dirlen >> 24,
				offset, offset >> 8, offset >> 16, offset >> 24,
				0, 0])); 

			const a = document.createElement("a");
			a.download = zipname ? zipname : "dec.zip";
			a.href = URL.createObjectURL(new Blob(acc.concat(cdr)));
			a.click();

		}
	};

	document.ondragover = () => false;
	document.ondrop = evt => {
		evt.preventDefault();
		if (evt.dataTransfer.items) {
			let gae;
			for (const name of ["getAsEntry", "webkitGetAsEntry"]) {
				if (evt.dataTransfer.items[0][name])
					gae = name;
			}

			if (gae) {
				const filelist = [];
				const scan = async entry => {
					if (entry.isFile) {
						await new Promise((res, rej) =>
							entry.file(e => {
								let path = entry.fullPath;
								if (path[0] == "/")
									path = path.slice(1);
								/* good enough for our purposes... */
								filelist.push({
									name: path,
									arrayBuffer: () => e.arrayBuffer()
								});
								res();
							}, rej));
					}
					else if (entry.isDirectory) {
						await new Promise((res, rej) =>
							entry.createReader().readEntries(entries => {
								Promise.all(entries.map(scan)).then(res, rej);
							}));
					}
				}

				const items = evt.dataTransfer.items;
				if (items[0].kind != "file")
					return;

				Promise.all([].map.call(items, item => scan(item[gae]()))).then(() => {
					processFiles(filelist, items[0][gae]().name + ".zip").catch(report);
				}, report);

				return false;
			}
		}

		if (evt.dataTransfer.files) {
			processFiles(evt.dataTransfer.files).catch(report);
			return false;
		}
	};
	document.querySelector("input[type=file]").oninput = evt => {
		processFiles(evt.target.files).catch(report);
	};
});